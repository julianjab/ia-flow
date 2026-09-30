import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  PipelineExecutionContext,
  Provider,
  ProviderRunContext,
  ProviderRunOutput,
} from '@ia-flow/agent-engine'
import { captureContext, createLogger, withInheritedAttributes } from '@ia-flow/telemetry'
import {
  type ClaudeCliConfig,
  type ClaudeCliMode,
  mergeClaudeCliConfig,
  parseClaudeCliConfig,
} from './config.js'
import { RunChannel } from './RunChannel.js'
import { RunServer } from './RunServer.js'
import { writeSessionFiles } from './SessionFiles.js'
import type { CliSession, Launcher, SessionExit } from './sessions/CliSession.js'
import { closeOrphan, type SessionRef } from './sessions/orphans.js'
import { PrintLauncher } from './sessions/PrintLauncher.js'
import { TmuxLauncher } from './sessions/TmuxLauncher.js'

/** La conversación de una corrida del CLI: la sesión de Claude Code, que se retoma con
 *  `--resume` (tras esperar un evento, o tras un reinicio del runner), y dónde corría — para
 *  cerrarla si quedó huérfana. */
export interface ClaudeCliConversation {
  sessionId: string
  session?: SessionRef
}

export interface ClaudeCliProviderOptions extends ClaudeCliConfig {
  /** El id con el que lo nombran los agentes (`provider: claude-cli`). */
  id: string
  /** El worktree de la corrida: donde corre la sesión. */
  cwd: (ctx: PipelineExecutionContext) => Promise<string>
  /** Default: `claude`. */
  bin?: string
  /** Cuántos agentes a la vez sobre este provider (`Provider.maxConcurrent`). */
  maxConcurrent?: number
  /** El servidor local compartido; default uno por proceso. */
  server?: RunServer
  /** Cómo se lanza cada modo (tests). */
  launchers?: Partial<Record<ClaudeCliMode, Launcher>>
  /** Cómo se cierra una sesión huérfana (tests). Default: `closeOrphan`. */
  closeOrphan?: (ref: SessionRef) => Promise<boolean>
}

const DEFAULT_TIMEOUT_MINUTES = 120
const DEFAULT_STOP_NUDGES = 2
/** Lo que se deja pasar entre que el modelo cierra el turno y se corta la sesión: que la
 *  respuesta de la tool terminal le llegue al CLI. */
const CLOSE_GRACE_MS = 500

let sharedServer: RunServer | undefined

/**
 * Un `Provider` sobre el CLI `claude` (Claude Code): el agente corre como una sesión del CLI en
 * el worktree de la task, con TODO el CLI habilitado (sus tools, `Task`, los `.claude/agents` del
 * repo) y, por MCP (`ia-flow`), las tools que el agente tiene configuradas — sus actions y las que
 * cierran el turno. El turno termina cuando el modelo llama una tool terminal por MCP: ahí se
 * corta la sesión y el engine lee lo que eligió, igual que con cualquier provider.
 *
 * Los hooks del CLI le devuelven al runner la traza de sus tools nativas (spans colgados del
 * agente) y le entregan el inbox de la ejecución (`PostToolUse`, `Stop`). La conversación es la
 * sesión del CLI: cada corrida arranca con `--session-id` y se retoma con `--resume`.
 */
export class ClaudeCliProvider implements Provider {
  readonly id: string
  // El CLI trabaja el worktree con sus tools (`Read`, `Edit`, `Bash`, `Task`): las del agente que
  // hacen lo mismo no le llegan por MCP.
  readonly workspace = 'native' as const
  readonly maxConcurrent?: number
  readonly log = createLogger('provider-anthropic-cli')
  private readonly defaults: ClaudeCliConfig

  constructor(private readonly options: ClaudeCliProviderOptions) {
    this.id = options.id
    if (options.maxConcurrent !== undefined) this.maxConcurrent = options.maxConcurrent
    const {
      id: _i,
      cwd: _c,
      bin: _b,
      maxConcurrent: _m,
      server: _s,
      launchers: _l,
      closeOrphan: _o,
      ...defaults
    } = options
    this.defaults = parseClaudeCliConfig(defaults)
  }

  async run(ctx: ProviderRunContext): Promise<ProviderRunOutput> {
    const cfg = mergeClaudeCliConfig(this.defaults, parseClaudeCliConfig(ctx.providerConfig))
    const mode = cfg.mode ?? 'print'
    const cwd = await this.options.cwd(ctx.ctx)
    const channel = new RunChannel({
      agentId: ctx.agentId,
      tools: ctx.tools,
      ...(ctx.inbox ? { inbox: ctx.inbox } : {}),
      parent: runContext(ctx),
      maxStopNudges: cfg.maxStopNudges ?? DEFAULT_STOP_NUDGES,
      ...(ctx.onText ? { onText: ctx.onText } : {}),
      since: new Date(),
    })
    const server = this.server()
    const endpoints = await server.open(channel)
    const resumed = conversationOf(ctx.resume?.conversation)
    // La sesión anterior sigue viva si el runner se reinició mientras corría: se cierra antes de
    // retomar su conversación en una nueva.
    const close = this.options.closeOrphan ?? closeOrphan
    if (resumed?.session && (await close(resumed.session))) {
      this.log.warn(`${ctx.agentId}: cerré la sesión huérfana ${describeRef(resumed.session)}`)
    }
    const sessionId = resumed?.sessionId ?? randomUUID()
    // Desde ya: si el runner muere a mitad de la corrida, se retoma esta sesión.
    let conversation: ClaudeCliConversation = { sessionId }
    ctx.saveConversation?.(conversation)

    const files = await writeSessionFiles({
      endpoints,
      systemPrompts: ctx.systemPrompts,
      exits: ctx.tools.filter((tool) => tool.terminal && !tool.failure).map((tool) => tool.name),
      mcpServers: ctx.mcpServers,
      env: credentialEnv(cfg.env ?? {}),
      ...(cfg.model ? { model: cfg.model } : {}),
      args: cfg.args ?? [],
      session: { id: sessionId, resume: resumed !== undefined },
    })
    const promptFile = join(files.dir, 'prompt.md')
    const prompt =
      resumed && ctx.resume
        ? `[Continuación de tu turno]\n${ctx.resume.message}\n\nSeguí donde quedaste.`
        : ctx.prompt
    await writeFile(promptFile, prompt, { mode: 0o600 })

    let session: CliSession | undefined
    try {
      session = await this.launcher(mode).launch({
        bin: this.options.bin ?? 'claude',
        argv: files.argv,
        promptFile,
        cwd,
        label: labelOf(ctx),
        ...(cfg.surface ? { surface: true } : {}),
      })
      this.log.info(`${ctx.agentId}: sesión ${mode} ${session.describe}`)
      if (session.ref) {
        conversation = { sessionId, session: session.ref }
        ctx.saveConversation?.(conversation)
      }
      const ended = await this.race(channel, session, cfg.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES)
      if (ended.kind === 'done') return { outcome: 'success', conversation }
      if (ended.kind === 'timeout') {
        return { outcome: 'error', summary: `la sesión del CLI superó ${ended.minutes} min` }
      }
      return {
        outcome: 'error',
        summary: `la sesión del CLI terminó sin cerrar el turno (código ${ended.exit.code ?? '?'})${tail(ended.exit.output)}`,
      }
    } finally {
      await channel.close().catch(() => {})
      if (session) {
        await delay(CLOSE_GRACE_MS)
        await session.close().catch(() => {})
      }
      server.close(channel)
      await files.cleanup().catch(() => {})
    }
  }

  private async race(
    channel: RunChannel,
    session: CliSession,
    minutes: number,
  ): Promise<
    { kind: 'done' } | { kind: 'exited'; exit: SessionExit } | { kind: 'timeout'; minutes: number }
  > {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ kind: 'timeout'; minutes: number }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout', minutes }), minutes * 60_000)
      timer.unref?.()
    })
    try {
      return await Promise.race([
        channel.done.then(() => ({ kind: 'done' as const })),
        // Un proceso que termina justo después de cerrar el turno cuenta como cerrado.
        session.exited.then((exit) =>
          channel.finished ? { kind: 'done' as const } : { kind: 'exited' as const, exit },
        ),
        timeout,
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private server(): RunServer {
    if (this.options.server) return this.options.server
    sharedServer ??= new RunServer()
    return sharedServer
  }

  private launcher(mode: ClaudeCliMode): Launcher {
    return (
      this.options.launchers?.[mode] ?? (mode === 'tmux' ? new TmuxLauncher() : new PrintLauncher())
    )
  }
}

/** El contexto del agente del que cuelga todo lo que llega por los hooks, con `ia.execution.id`
 *  seguro (la pipeline ya lo hereda; un agente suelto con ejecución también lo lleva). */
function runContext(ctx: ProviderRunContext) {
  const execution = ctx.ctx.execution
  return execution
    ? withInheritedAttributes({ 'ia.execution.id': execution.id }, captureContext)
    : captureContext()
}

/** La sesión a retomar, si la conversación es de este provider. */
function conversationOf(value: unknown): ClaudeCliConversation | undefined {
  const { sessionId, session } = (value ?? {}) as { sessionId?: unknown; session?: unknown }
  if (typeof sessionId !== 'string' || !sessionId) return undefined
  return isSessionRef(session) ? { sessionId, session } : { sessionId }
}

function isSessionRef(value: unknown): value is SessionRef {
  const ref = value as { kind?: unknown; name?: unknown; pid?: unknown } | undefined
  return (
    (ref?.kind === 'tmux' && typeof ref.name === 'string') ||
    (ref?.kind === 'pid' && typeof ref.pid === 'number')
  )
}

function describeRef(ref: SessionRef): string {
  return ref.kind === 'tmux' ? `tmux ${ref.name}` : `pid ${ref.pid}`
}

/** La credencial OAuth del CLI viaja en el `--settings`, no en el shell. */
function credentialEnv(env: Record<string, string>): Record<string, string> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
  return token && !env.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: token, ...env } : env
}

/** `<agente>-task-<n>`: lo que ve un humano en `tmux ls`. */
function labelOf(ctx: ProviderRunContext): string {
  const number = (ctx.ctx.event.payload as { number?: unknown } | undefined)?.number
  return typeof number === 'number' ? `${ctx.agentId}-task-${number}` : ctx.agentId
}

function tail(output: string): string {
  const text = output.trim()
  return text ? `: ${text.slice(-800)}` : ''
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
