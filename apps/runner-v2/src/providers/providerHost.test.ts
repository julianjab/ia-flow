import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderRegistry } from '@ia-flow/agent-engine'
import type { CliLaunchSpec, LaunchedCli, SessionExit } from '@ia-flow/provider-anthropic-cli'
import { HostClient, type HostTask, RemoteHub } from '@ia-flow/provider-remote'
import type { RunnerConfig } from '../config/RunnerConfig.js'
import { cliTaskRunner, hostSettings } from './providerHost.js'
import { nodeHandler } from './remoteHosts.js'

const cfgOf = (host: RunnerConfig['host'], providers: RunnerConfig['providers'] = {}) =>
  ({ host, providers }) as RunnerConfig

const CLI = {
  'claude-tmux': { type: 'claude-cli', mode: 'tmux', model: 'opus', bin: '/bin/claude' },
}

const task = (over: Partial<HostTask> = {}): HostTask => ({
  runId: 'r1',
  agentId: 'implementer',
  label: 'implementer-task-7',
  prompt: 'hacé la tarea',
  systemPrompts: ['sos un agente'],
  exits: ['submit_done'],
  mcpServers: [{ id: 'github-mcp', config: { url: 'https://mcp', authorizationToken: 't' } }],
  providerConfig: { model: 'sonnet' },
  event: {
    id: 'e1',
    type: 'issue.status_changed',
    payload: { owner: 'la-haus', repo: 'eks', number: 7 },
    occurredAt: '2026-09-30T00:00:00.000Z',
  },
  session: { id: 's1', resume: false },
  endpoints: { mcp: '/v1/runs/tk/mcp', hooks: '/v1/runs/tk/hooks', report: '/v1/runs/tk/report' },
  ...over,
})

/** Una sesión de mentira: termina cuando el test la suelta. */
function fakeLaunch() {
  const specs: CliLaunchSpec[] = []
  let finish!: (exit: SessionExit) => void
  let closed = false
  const launch = async (spec: CliLaunchSpec): Promise<LaunchedCli> => {
    specs.push(spec)
    return {
      session: {
        exited: new Promise((resolve) => {
          finish = resolve
        }),
        describe: 'tmux attach -t x',
        close: async () => {
          closed = true
        },
      },
      cleanup: async () => {},
    }
  }
  return { launch, specs, exit: (exit: SessionExit) => finish(exit), closed: () => closed }
}

describe('hostSettings', () => {
  it('takes name, runner and token (the environment wins) and the only claude-cli it lends', () => {
    const settings = hostSettings(
      cfgOf(
        {
          name: 'laptop',
          runner: 'https://runner',
          accepts: [{ field: 'repo', op: 'eq', value: 'eks' }],
        },
        CLI,
      ),
      { IA_FLOW_HOST_TOKEN: 'secreto', IA_FLOW_HOST_NAME: 'otra' },
    )
    expect(settings).toMatchObject({
      name: 'otra',
      runner: 'https://runner',
      token: 'secreto',
      maxConcurrent: 1,
      accepts: [{ field: 'repo', op: 'eq', value: 'eks' }],
      provider: {
        id: 'claude-tmux',
        defaults: { mode: 'tmux', model: 'opus' },
        bin: '/bin/claude',
      },
    })
  })

  it('says what is missing, and which claude-cli to name when there are several', () => {
    expect(() => hostSettings(cfgOf({}, CLI), {})).toThrow(
      /host.name .*host.runner .*IA_FLOW_HOST_TOKEN/,
    )
    const two = { ...CLI, 'claude-cli': { type: 'claude-cli' } }
    expect(() =>
      hostSettings(cfgOf({ name: 'l', runner: 'https://r' }, two), { IA_FLOW_HOST_TOKEN: 't' }),
    ).toThrow(/nombrá cuál en host.provider/)
    expect(
      hostSettings(cfgOf({ name: 'l', runner: 'https://r', provider: 'claude-cli' }, two), {
        IA_FLOW_HOST_TOKEN: 't',
      }).provider.id,
    ).toBe('claude-cli')
  })
})

describe('cliTaskRunner', () => {
  const provider = { id: 'claude-tmux', defaults: { mode: 'tmux' as const, model: 'opus' } }

  it('launches claude in the task worktree against the run channel in the runner, and reports how it ended', async () => {
    const fake = fakeLaunch()
    const closedOrphans: string[] = []
    const dirs: unknown[] = []
    const run = cliTaskRunner({
      session: {
        dirFor: async (ctx) => {
          dirs.push(ctx.event.payload)
          return '/work/eks-7'
        },
      },
      provider,
      log: () => {},
      launch: fake.launch,
      close: async (ref) => {
        closedOrphans.push(ref.kind === 'tmux' ? ref.name : '')
        return false
      },
    })
    const ended = run(task(), { base: 'https://runner' }, new AbortController().signal)
    await Bun.sleep(5)
    fake.exit({ code: 1, output: 'se cayó' })

    expect(await ended).toEqual({ status: 'exited', code: 1, message: 'se cayó' })
    expect(dirs).toEqual([{ owner: 'la-haus', repo: 'eks', number: 7 }])
    expect(closedOrphans).toEqual(['iaflow-implementer-task-7'])
    expect(fake.specs[0]).toMatchObject({
      endpoints: { mcp: 'https://runner/v1/runs/tk/mcp', hooks: 'https://runner/v1/runs/tk/hooks' },
      cwd: '/work/eks-7',
      label: 'implementer-task-7',
      exits: ['submit_done'],
      // Los defaults del provider que presta, pisados por los del agente.
      config: { mode: 'tmux', model: 'sonnet' },
      session: { id: 's1', resume: false },
    })
    expect(fake.closed()).toBe(true)
  })

  it("forwards the session's model requests to the runner's transcript endpoint when it ends", async () => {
    const fake = fakeLaunch()
    const root = await mkdtemp(join(tmpdir(), 'ia-flow-host-'))
    await mkdir(join(root, '-work-eks'))
    await writeFile(
      join(root, '-work-eks', 's1.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        message: {
          id: 'm1',
          model: 'claude-opus',
          content: [{ type: 'text', text: 'hecho' }],
          usage: { input_tokens: 4, output_tokens: 2 },
        },
      })}\n`,
    )
    const posts: Array<{ url: string; body: unknown }> = []
    const run = cliTaskRunner({
      session: { dirFor: async () => '/work' },
      provider,
      log: () => {},
      launch: fake.launch,
      close: async () => false,
      transcriptsDir: root,
      fetchImpl: (async (url: string, init: RequestInit) => {
        posts.push({ url, body: JSON.parse(String(init.body)) })
        return new Response('{}')
      }) as unknown as typeof fetch,
    })
    const withTranscript = task({
      endpoints: { ...task().endpoints, transcript: '/v1/runs/tk/transcript' },
    })
    const ended = run(withTranscript, { base: 'https://runner' }, new AbortController().signal)
    await Bun.sleep(5)
    fake.exit({ code: 0, output: '' })
    await ended
    await rm(root, { recursive: true, force: true })

    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toBe('https://runner/v1/runs/tk/transcript')
    expect(posts[0]?.body).toMatchObject({
      messages: [{ id: 'm1', usage: { inputTokens: 4, outputTokens: 2 }, texts: ['hecho'] }],
    })
  })

  it('a run the runner closes (the model already chose its exit) ends without a report', async () => {
    const fake = fakeLaunch()
    const controller = new AbortController()
    const run = cliTaskRunner({
      session: { dirFor: async () => '/work' },
      provider,
      log: () => {},
      launch: fake.launch,
      close: async () => false,
    })
    const ended = run(task(), { base: 'https://runner' }, controller.signal)
    await Bun.sleep(5)
    controller.abort()
    expect(await ended).toBeUndefined()
    expect(fake.closed()).toBe(true)
  })

  it('asks the workspace for the lane worktree, and marks it in use while the session runs', async () => {
    const fake = fakeLaunch()
    const lanes: (string | undefined)[] = []
    const marks: string[] = []
    const run = cliTaskRunner({
      session: {
        dirFor: async (ctx) => {
          lanes.push(ctx.lane)
          return `/work/eks-7--${ctx.lane}`
        },
      },
      provider,
      log: () => {},
      launch: fake.launch,
      close: async () => false,
      worktrees: {
        begin: async (prepare) => {
          const path = await prepare()
          marks.push(`begin ${path}`)
          return path
        },
        end: (path) => marks.push(`end ${path}`),
      },
    })
    const ended = run(
      task({ lane: 'e2e' }),
      { base: 'https://runner' },
      new AbortController().signal,
    )
    await Bun.sleep(5)
    expect(marks).toEqual(['begin /work/eks-7--e2e'])
    fake.exit({ code: 0, output: '' })
    await ended
    expect(lanes).toEqual(['e2e'])
    expect(marks).toEqual(['begin /work/eks-7--e2e', 'end /work/eks-7--e2e'])
  })

  it('a launch that fails still releases the worktree', async () => {
    const marks: string[] = []
    const run = cliTaskRunner({
      session: { dirFor: async () => '/work' },
      provider,
      log: () => {},
      launch: async () => {
        throw new Error('sin claude')
      },
      close: async () => false,
      worktrees: {
        begin: async (prepare) => {
          const p = await prepare()
          marks.push(`begin ${p}`)
          return p
        },
        end: (p) => marks.push(`end ${p}`),
      },
    })
    await expect(
      run(task(), { base: 'https://runner' }, new AbortController().signal),
    ).rejects.toThrow('sin claude')
    expect(marks).toEqual(['begin /work', 'end /work'])
  })
})

describe('the runner hosts API over the webhook server (node http)', () => {
  it('a host subscribes over HTTP and shows up as remote:<name>', async () => {
    const registry = new ProviderRegistry()
    const hub = new RemoteHub({ registry, token: 'secreto', longPollMs: 20, sweepIntervalMs: 0 })
    const api = nodeHandler((req) => hub.fetch(req))
    const server = createServer((req, res) => {
      void api.handle(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    const client = new HostClient({
      runnerUrl: `http://127.0.0.1:${port}`,
      token: 'secreto',
      name: 'laptop',
      maxConcurrent: 1,
      accepts: [],
      run: async () => undefined,
      retryMs: 10,
    })
    client.start()
    try {
      for (let i = 0; i < 100 && !registry.resolve('remote:laptop'); i++) await Bun.sleep(10)
      expect(registry.resolve('remote:laptop')?.workspace).toBe('native')
      const other = await fetch(`http://127.0.0.1:${port}/api/otra`)
      expect(other.status).toBe(404)
    } finally {
      await client.stop()
      hub.close()
      server.close()
    }
  })
})
