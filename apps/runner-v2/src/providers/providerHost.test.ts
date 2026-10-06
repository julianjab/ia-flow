import { describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type PipelineExecutionContext,
  type Provider,
  ProviderRegistry,
  type ProviderRunContext,
} from '@ia-flow/agent-engine'
import { CLOSED_BY_RUNNER, HostClient, type HostTask, RemoteHub } from '@ia-flow/provider-remote'
import type { WorkspaceSession } from '@ia-flow/workspace'
import type { RunnerConfig } from '../config/RunnerConfig.js'
import { hostSettings, providerTaskRunner } from './providerHost.js'
import { nodeHandler } from './remoteHosts.js'

const cfgOf = (host: RunnerConfig['host'], providers: RunnerConfig['providers'] = {}) =>
  ({ host, providers }) as RunnerConfig

const CLI = { 'claude-tmux': { type: 'claude-cli', mode: 'tmux', model: 'opus' } }
const ENV = { IA_FLOW_HOST_TOKEN: 'secreto' }

const task = (over: Partial<HostTask> = {}): HostTask => ({
  runId: 'r1',
  agentId: 'implementer',
  prompt: 'hacé la tarea',
  systemPrompts: ['sos un agente'],
  variables: { repo: 'eks' },
  mcpServers: [{ id: 'github-mcp', config: { url: 'https://mcp', authorizationToken: 't' } }],
  providerConfig: { model: 'sonnet' },
  tools: [
    { name: 'submit_done', description: 'cierra', inputSchema: { type: 'object' }, terminal: true },
  ],
  workspaceTools: [
    { name: 'bash_run', origin: { action: 'bash_run', options: { deny: ['rm -rf'] } } },
    { name: 'run_agent', origin: { action: 'run_agent', options: {} } },
  ],
  event: {
    id: 'e1',
    type: 'issue.status_changed',
    payload: { owner: 'la-haus', repo: 'eks', number: 7 },
    occurredAt: '2026-09-30T00:00:00.000Z',
  },
  endpoints: {
    tools: '/v1/runs/tk/tools',
    inbox: '/v1/runs/tk/inbox',
    conversation: '/v1/runs/tk/conversation',
    text: '/v1/runs/tk/text',
    result: '/v1/runs/tk/result',
  },
  ...over,
})

/** El runner, de mentira: contesta las rutas de la corrida y anota lo que le llega. */
function fakeRunner() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ path, body })
    if (path.endsWith('/tools')) return Response.json({ text: `ok ${body.name}`, isError: false })
    if (path.endsWith('/inbox')) return Response.json({ messages: [] })
    return Response.json({})
  }) as typeof fetch
  return { calls, fetchImpl }
}

/** Un provider de mentira: anota su contexto, llama la tool terminal y devuelve lo suyo. */
function fakeProvider(workspace: Provider['workspace']) {
  const runs: ProviderRunContext[] = []
  const provider: Provider = {
    id: 'claude-tmux',
    ...(workspace ? { workspace } : {}),
    run: async (ctx) => {
      runs.push(ctx)
      await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({ summary: 'listo' })
      ctx.saveConversation?.({ sessionId: 's1' })
      return { outcome: 'success', summary: 'hecho', conversation: { sessionId: 's1' } }
    },
  }
  return { provider, runs }
}

function fakeSession() {
  const asked: PipelineExecutionContext[] = []
  const session = {
    dirFor: async (ctx: PipelineExecutionContext) => {
      asked.push(ctx)
      return '/wt/eks-7'
    },
  } as unknown as WorkspaceSession
  return { session, asked }
}

describe('hostSettings', () => {
  it('takes name, runner and token (the environment wins) and the provider it runs with', () => {
    const settings = hostSettings(
      cfgOf(
        {
          name: 'laptop',
          runner: 'https://runner',
          accepts: [{ field: 'repo', op: 'eq', value: 'eks' }],
        },
        CLI,
      ),
      { ...ENV, IA_FLOW_HOST_NAME: 'otra' },
    )
    expect(settings).toEqual({
      name: 'otra',
      runner: 'https://runner',
      token: 'secreto',
      maxConcurrent: 1,
      accepts: [{ field: 'repo', op: 'eq', value: 'eks' }],
      provider: 'claude-tmux',
    })
  })

  it('runs with any provider of providers — the Messages API too — named in host.provider', () => {
    const cfg = cfgOf({ name: 'l', runner: 'https://r', provider: 'anthropic-api' }, CLI)
    expect(hostSettings(cfg, ENV).provider).toBe('anthropic-api')
    expect(() =>
      hostSettings(cfgOf({ name: 'l', runner: 'https://r', provider: 'otro' }, CLI), ENV),
    ).toThrow(/host.provider: "otro" no está en providers \(hay: anthropic-api, claude-tmux\)/)
  })

  it('says what is missing, and to name the provider when it is not obvious', () => {
    expect(() => hostSettings(cfgOf({}, CLI), {})).toThrow(
      /host.name .*host.runner .*IA_FLOW_HOST_TOKEN/,
    )
    const two = { ...CLI, 'claude-cli': { type: 'claude-cli' } }
    expect(() => hostSettings(cfgOf({ name: 'l', runner: 'https://r' }, two), ENV)).toThrow(
      /nombrá con qué provider corre en host.provider/,
    )
  })
})

describe('providerTaskRunner', () => {
  it('runs the provider as the runner would: the task context, engine tools against the runner, its output back', async () => {
    const { provider, runs } = fakeProvider('native')
    const { calls, fetchImpl } = fakeRunner()
    const { session, asked } = fakeSession()
    const ended: unknown[] = []
    const run = providerTaskRunner({
      provider,
      session,
      gitCredential: async () => 'gh-token',
      log: () => {},
      fetchImpl,
      worktrees: {
        begin: async (prepare) => prepare(),
        end: async (path, ending) => {
          ended.push([path, ending])
          return 'removed'
        },
      },
    })

    const result = await run(task(), { base: 'http://runner' }, new AbortController().signal)

    expect(result).toEqual({
      status: 'output',
      output: { outcome: 'success', summary: 'hecho', conversation: { sessionId: 's1' } },
    })
    const ctx = runs[0] as ProviderRunContext
    expect(ctx).toMatchObject({
      agentId: 'implementer',
      prompt: 'hacé la tarea',
      systemPrompts: ['sos un agente'],
      variables: { repo: 'eks' },
      providerConfig: { model: 'sonnet' },
      mcpServers: [{ id: 'github-mcp' }],
    })
    expect(ctx.ctx.event.payload).toMatchObject({ repo: 'eks', number: 7 })
    expect(asked[0]?.event.id).toBe('e1')
    // Un provider nativo (el CLI) trae sus tools de workspace: sólo le llegan las del engine.
    expect(ctx.tools.map((tool) => tool.name)).toEqual(['submit_done'])
    expect(calls).toContainEqual({
      path: '/v1/runs/tk/tools',
      body: { name: 'submit_done', input: { summary: 'listo' } },
    })
    expect(calls).toContainEqual({
      path: '/v1/runs/tk/conversation',
      body: { conversation: { sessionId: 's1' } },
    })
    // El modelo cerró con una salida: el worktree se entera.
    expect(ended).toEqual([['/wt/eks-7', 'done']])
  })

  it('a provider that works the runner workspace (the Messages API) gets the workspace tools rebuilt here', async () => {
    const { provider, runs } = fakeProvider('runner')
    const { fetchImpl } = fakeRunner()
    const run = providerTaskRunner({
      provider,
      session: fakeSession().session,
      gitCredential: async () => undefined,
      log: () => {},
      fetchImpl,
    })
    await run(task(), { base: 'http://runner' }, new AbortController().signal)

    const tools = runs[0]?.tools ?? []
    expect(tools.map((tool) => tool.name)).toEqual(['submit_done', 'bash_run', 'run_agent'])
    expect(tools.find((tool) => tool.name === 'bash_run')).toMatchObject({ workspace: true })
    // Una que el host no sabe rearmar le dice al modelo por qué no está.
    const runAgent = tools.find((tool) => tool.name === 'run_agent')
    await expect(Promise.resolve().then(() => runAgent?.handler({}))).rejects.toThrow(
      /no corre en un host remoto/,
    )
  })

  it('asks the workspace for the lane worktree', async () => {
    const { provider } = fakeProvider('native')
    const { session, asked } = fakeSession()
    const run = providerTaskRunner({
      provider,
      session,
      gitCredential: async () => undefined,
      log: () => {},
      fetchImpl: fakeRunner().fetchImpl,
    })
    await run(
      task({ lane: 'e2e-visual-qa' }),
      { base: 'http://runner' },
      new AbortController().signal,
    )
    expect(asked[0]?.lane).toBe('e2e-visual-qa')
  })

  it('a run the runner closes hands the provider the signal, and the worktree is not told how it ended', async () => {
    const seen: Array<AbortSignal | undefined> = []
    const provider: Provider = {
      id: 'anthropic-api',
      run: async (ctx) => {
        seen.push(ctx.signal)
        await new Promise((resolve) =>
          ctx.signal?.addEventListener('abort', resolve, { once: true }),
        )
        return { outcome: 'error', summary: 'cortada' }
      },
    }
    const ended: unknown[] = []
    const run = providerTaskRunner({
      provider,
      session: fakeSession().session,
      gitCredential: async () => undefined,
      log: () => {},
      fetchImpl: fakeRunner().fetchImpl,
      worktrees: {
        begin: async (prepare) => prepare(),
        end: async (path, ending) => {
          ended.push([path, ending])
          return 'removed'
        },
      },
    })
    const controller = new AbortController()
    const running = run(task(), { base: 'http://runner' }, controller.signal)
    for (let i = 0; i < 100 && seen.length === 0; i++) await Bun.sleep(5)
    controller.abort(CLOSED_BY_RUNNER)
    expect(await running).toMatchObject({ status: 'output', output: { outcome: 'error' } })
    expect(seen[0]).toBe(controller.signal)
    expect(ended).toEqual([['/wt/eks-7', undefined]])
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
      run: async () => ({ status: 'output', output: { outcome: 'success' } }),
      retryMs: 10,
    })
    client.start()
    try {
      for (let i = 0; i < 100 && !registry.resolve('remote:laptop'); i++) await Bun.sleep(10)
      expect(registry.resolve('remote:laptop')?.workspace).toBe('runner')
      const other = await fetch(`http://127.0.0.1:${port}/api/otra`)
      expect(other.status).toBe(404)
    } finally {
      await client.stop()
      hub.close()
      server.close()
    }
  })
})
