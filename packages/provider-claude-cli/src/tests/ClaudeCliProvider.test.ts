import { readFileSync } from 'node:fs'
import { createEvent, EventBus, type ProviderRunContext, type Tool } from '@ia-flow/agent-engine'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeCliProvider } from '../ClaudeCliProvider.js'
import { RunServer } from '../RunServer.js'
import type { CliSession, Launcher, LaunchSpec, SessionExit } from '../sessions/CliSession.js'
import { sessionName, shellQuote } from '../sessions/TmuxLauncher.js'

const server = new RunServer()
afterAll(() => server.stop())

const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1] ?? ''

/** Un "CLI" de mentira: lee su `--mcp-config` y hace lo que le pide el guion contra el MCP real. */
class FakeCli implements Launcher {
  readonly launched: LaunchSpec[] = []
  constructor(
    private readonly script: (mcpUrl: string, spec: LaunchSpec) => Promise<SessionExit | undefined>,
  ) {}

  async launch(spec: LaunchSpec): Promise<CliSession> {
    this.launched.push({ ...spec, argv: [...spec.argv] })
    const config = JSON.parse(readFileSync(flag(spec.argv, '--mcp-config'), 'utf-8'))
    const url = config.mcpServers['ia-flow'].url as string
    let closed = false
    const exited = this.script(url, spec).then((exit) => exit ?? new Promise<SessionExit>(() => {}))
    return {
      exited,
      describe: 'fake',
      close: async () => {
        closed = true
      },
      get closedFlag() {
        return closed
      },
    } as CliSession
  }
}

const rpc = (url: string, method: string, params: Record<string, unknown> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((res) => res.json())

const submit: Tool = {
  name: 'submit_done',
  description: 'terminar',
  inputSchema: { type: 'object' },
  handler: () => 'ok',
  terminal: true,
}

function runContext(overrides: Partial<ProviderRunContext> = {}): ProviderRunContext & {
  saved: unknown[]
} {
  const saved: unknown[] = []
  return {
    agentId: 'implementer',
    prompt: 'implementá X',
    systemPrompts: ['Sos un implementador.'],
    variables: {},
    providerConfig: {},
    mcpServers: [
      {
        id: 'github-mcp',
        config: { type: 'http', url: 'https://mcp.example', authorizationToken: () => 'gh-token' },
      },
    ],
    tools: [submit],
    ctx: {
      event: createEvent('build', { number: 7 }),
      steps: {},
      bus: new EventBus(),
      pipelineId: 'build',
    },
    saveConversation: (conversation) => saved.push(conversation),
    ...overrides,
    saved,
  }
}

const provider = (cli: FakeCli, extra: Record<string, unknown> = {}) =>
  new ClaudeCliProvider({
    id: 'claude-cli',
    cwd: async () => '/tmp/worktree',
    server,
    launchers: { print: cli, tmux: cli },
    model: 'opus',
    ...extra,
  })

describe('ClaudeCliProvider', () => {
  it('runs a session whose MCP serves the agent tools, and ends when a terminal tool is called', async () => {
    const cli = new FakeCli(async (url) => {
      await rpc(url, 'initialize')
      const listed = await rpc(url, 'tools/list')
      expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(['submit_done'])
      await rpc(url, 'tools/call', { name: 'submit_done', arguments: {} })
      return undefined
    })
    const ctx = runContext()

    const output = await provider(cli).run(ctx)

    expect(output.outcome).toBe('success')
    const sessionId = (output.conversation as { sessionId: string }).sessionId
    expect(ctx.saved).toEqual([{ sessionId }])
    const [spec] = cli.launched
    expect(spec?.cwd).toBe('/tmp/worktree')
    expect(spec?.label).toBe('implementer-task-7')
    expect(flag(spec?.argv ?? [], '--session-id')).toBe(sessionId)
    expect(flag(spec?.argv ?? [], '--model')).toBe('opus')
    expect(spec?.argv).toContain('--dangerously-skip-permissions')
  })

  it('writes the system prompt, the hooks and the external MCPs the CLI reads', async () => {
    let files: { sysprompt: string; settings: any; mcp: any; prompt: string } | undefined
    const cli = new FakeCli(async (url, spec) => {
      files = {
        sysprompt: readFileSync(flag(spec.argv, '--append-system-prompt-file'), 'utf-8'),
        settings: JSON.parse(readFileSync(flag(spec.argv, '--settings'), 'utf-8')),
        mcp: JSON.parse(readFileSync(flag(spec.argv, '--mcp-config'), 'utf-8')),
        prompt: readFileSync(spec.promptFile, 'utf-8'),
      }
      await rpc(url, 'tools/call', { name: 'submit_done', arguments: {} })
      return undefined
    })

    await provider(cli, { env: { FOO: 'bar' } }).run(runContext())

    expect(files?.prompt).toBe('implementá X')
    expect(files?.sysprompt).toMatch(/^Sos un implementador\.\n\n## Sesión desatendida/)
    expect(files?.sysprompt).toContain('`mcp__ia-flow__submit_done`')
    expect(files?.settings.env).toMatchObject({ FOO: 'bar' })
    expect(Object.keys(files?.settings.hooks)).toEqual(
      expect.arrayContaining(['PreToolUse', 'PostToolUse', 'Stop']),
    )
    expect(files?.settings.hooks.PostToolUse[0].hooks[0].command).toMatch(
      /curl .*\/hooks\/[0-9a-f-]+\/PostToolUse' \|\| true$/,
    )
    expect(files?.mcp.mcpServers['github-mcp']).toEqual({
      type: 'http',
      url: 'https://mcp.example',
      headers: { Authorization: 'Bearer gh-token' },
    })
  })

  it('resumes the saved session with what happened as the prompt', async () => {
    let prompt = ''
    const cli = new FakeCli(async (url, spec) => {
      prompt = readFileSync(spec.promptFile, 'utf-8')
      await rpc(url, 'tools/call', { name: 'submit_done', arguments: {} })
      return undefined
    })

    const output = await provider(cli).run(
      runContext({ resume: { conversation: { sessionId: 's-1' }, message: 'Llegó el CI verde.' } }),
    )

    expect(flag(cli.launched[0]?.argv ?? [], '--resume')).toBe('s-1')
    expect(cli.launched[0]?.argv).not.toContain('--session-id')
    expect(prompt).toBe('[Mientras esperabas]\nLlegó el CI verde.')
    expect(output.conversation).toEqual({ sessionId: 's-1' })
  })

  it('a session that ends without closing the turn is an error with its output', async () => {
    const cli = new FakeCli(async () => ({ code: 1, output: 'Invalid API key' }))
    const output = await provider(cli).run(runContext())
    expect(output.outcome).toBe('error')
    expect(output.summary).toContain('Invalid API key')
  })

  it('rejects a providerConfig with keys of another provider', async () => {
    const cli = new FakeCli(async () => undefined)
    await expect(
      provider(cli).run(runContext({ providerConfig: { maxTokens: 1 } })),
    ).rejects.toThrow(/claude-cli inválido/)
  })
})

describe('tmux helpers', () => {
  it('names sessions without tmux separators and quotes shell args', () => {
    expect(sessionName('implementer-task-7')).toBe('iaflow-implementer-task-7')
    expect(sessionName('a:b.c')).toBe('iaflow-a-b-c')
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })
})
