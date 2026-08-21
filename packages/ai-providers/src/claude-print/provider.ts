// Provider `claude-print` — invoca el CLI `claude` en modo no interactivo
// (`-p`) y captura stdout. A diferencia de `tmux-claude`/`iterm-claude` (que
// abren una sesión de terminal persistente, con su propio hook lifecycle de
// worktree y entrega de tools vía --mcp-config), este es `kind: 'sync'`: un
// solo proceso, corre, termina, devuelve texto — sin loop de tools propio
// del engine. Pensado como el caso simple que corre dentro de
// `apps/ai-provider-gateway` (fetch directo a Anthropic no siempre es una
// opción — algunas cuentas sólo tienen la suscripción de Claude Code, no una
// API key — y tmux/iTerm no tienen sentido dentro de un contenedor headless).
//
// No hay wiring de tools/MCP acá a propósito: si el prompt necesita tools,
// usa anthropic-api (loop nativo) o tmux/iterm-claude (vía --mcp-config). El
// alcance de este provider es completions de un solo turno.
import type { IAgentProvider, ProviderInput, ProviderOutput } from '../contract.js'

export interface ClaudePrintLog {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
}

export interface ClaudePrintProviderDeps {
  log: ClaudePrintLog
  /** Default 10 minutos — un `-p` sin loop de tools no debería tardar más. */
  timeoutMs?: number
}

interface ClaudePrintAgentConfig {
  model?: string
  dangerouslySkipPermissions?: boolean
}

function parseAgentConfig(raw: unknown): ClaudePrintAgentConfig {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  return {
    model: typeof r.model === 'string' ? r.model : undefined,
    dangerouslySkipPermissions:
      typeof r.dangerouslySkipPermissions === 'boolean' ? r.dangerouslySkipPermissions : undefined,
  }
}

function buildFinalPrompt(input: ProviderInput): string {
  const systemText = (input.systemPromptBlocks ?? []).map((b) => b.text).join('\n\n')
  return systemText ? `${systemText}\n\n${input.prompt}` : input.prompt
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  return await new Response(stream).text()
}

/** Minimal shape consumed from `Bun.spawn` — declared locally (not imported
 *  from Bun's types) so the test seam below can substitute a plain mock
 *  without pulling in every optional field. Same pattern as
 *  packages/tools/src/exec/exec.ts's `_execInternals`. */
export interface SpawnedProc {
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  exited: Promise<number>
  kill: (signal?: number | string) => void
}

/** Test-only indirection — overriding `spawn` lets unit tests drive the
 *  exit-code / timeout / abort paths without shelling out to a real
 *  `claude` binary. In production this is a pass-through to `Bun.spawn`. */
export const _claudePrintInternals: {
  spawn: (argv: string[], cwd: string | undefined) => SpawnedProc
} = {
  spawn: (argv, cwd) =>
    Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' }) as unknown as SpawnedProc,
}

export class ClaudePrintProvider implements IAgentProvider {
  readonly id = 'claude-print'
  readonly kind = 'sync' as const
  readonly name = 'Claude Print'
  readonly description =
    'Invoca `claude -p` (modo no interactivo, sin sesión de terminal) y captura stdout. Sin loop de tools propio — completions de un solo turno.'

  constructor(private deps: ClaudePrintProviderDeps) {}

  async run(input: ProviderInput): Promise<ProviderOutput> {
    const cfg = parseAgentConfig(input.providerConfig)
    const finalPrompt = buildFinalPrompt(input)

    const argv = ['claude', '-p', finalPrompt]
    if (cfg.model) argv.push('--model', cfg.model)
    if (cfg.dangerouslySkipPermissions) argv.push('--dangerously-skip-permissions')

    const t0 = Date.now()
    const proc = _claudePrintInternals.spawn(argv, input.cwd)

    const timeoutMs = this.deps.timeoutMs ?? 10 * 60_000
    const timeout = setTimeout(() => proc.kill(), timeoutMs)
    const onAbort = () => proc.kill()
    input.signal?.addEventListener('abort', onAbort)

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
        proc.exited,
      ])
      const ms = Date.now() - t0

      if (exitCode !== 0) {
        this.deps.log.warn(
          { taskId: input.taskId, exitCode, ms, stderr: stderr.slice(0, 2000) },
          'claude-print exited non-zero',
        )
        return {
          content: stdout.trim() || stderr.trim() || `claude -p exited with code ${exitCode}`,
          mode: 'api',
          stopReason: 'error',
        }
      }

      this.deps.log.info({ taskId: input.taskId, ms, outBytes: stdout.length }, 'claude-print ok')
      return { content: stdout.trim(), mode: 'api', stopReason: 'end_turn' }
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', onAbort)
    }
  }
}
