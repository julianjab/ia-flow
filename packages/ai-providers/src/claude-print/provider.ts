// Provider `claude-print` — invoca el CLI `claude` en modo no interactivo
// (`-p`) y captura stdout. A diferencia de `tmux-claude`/`iterm-claude` (que
// abren una sesión de terminal persistente, con su propio hook lifecycle de
// worktree y entrega de tools vía el daemon local), este es `kind: 'sync'`:
// un solo proceso, corre, termina, devuelve texto — sin loop de tools propio
// del engine. Pensado como el caso simple que corre dentro de
// `apps/ai-provider-gateway` (fetch directo a Anthropic no siempre es una
// opción — algunas cuentas sólo tienen la suscripción de Claude Code, no una
// API key — y tmux/iTerm no tienen sentido dentro de un contenedor headless,
// que además no corre el daemon de ia-flow, así que no hay `/api/mcp` local
// al que apuntar la entrega de tools del agente).
//
// mcpServers SÍ se soporta (mismo `--mcp-config` que arman los providers de
// terminal — writeMcpConfigFile es la pieza compartida, ver
// ../claude-cli/mcp-config.ts) porque son servidores MCP explícitos del
// providerConfig, no requieren un daemon. `env` se pasa directo al proceso
// spawneado (Bun.spawn admite `env`) — a diferencia de los providers de
// terminal, que lo escriben en un settings.json porque corren dentro de una
// sesión de shell interactiva que no controlan del todo (ver el comentario
// en terminal/base.ts sobre por qué evitan exportarlas ahí). Acá spawneamos
// el proceso nosotros mismos, así que no hace falta ese rodeo.
//
// Lo que sigue sin soportar, a propósito: entrega de tools del agente vía
// daemon (`ia-flow-tools` MCP), hooks forwarding (Ejecuciones tab) y manejo
// de worktree — los tres asumen un daemon de ia-flow local, que no existe en
// el contexto donde corre este provider.
import { unlink } from 'node:fs/promises'
import { type McpServers, McpServersSchema } from '@ia-flow/shared'
import { writeMcpConfigFile } from '../claude-cli/mcp-config.js'
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
  mcpServers?: McpServers
  env?: Record<string, string>
}

function parseAgentConfig(raw: unknown): ClaudePrintAgentConfig {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const mcpParsed = McpServersSchema.safeParse(r.mcpServers)
  return {
    model: typeof r.model === 'string' ? r.model : undefined,
    dangerouslySkipPermissions:
      typeof r.dangerouslySkipPermissions === 'boolean' ? r.dangerouslySkipPermissions : undefined,
    mcpServers:
      mcpParsed.success && Object.keys(mcpParsed.data).length ? mcpParsed.data : undefined,
    env:
      r.env && typeof r.env === 'object'
        ? Object.fromEntries(
            Object.entries(r.env as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          )
        : undefined,
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
  spawn: (
    argv: string[],
    cwd: string | undefined,
    env: Record<string, string> | undefined,
  ) => SpawnedProc
} = {
  spawn: (argv, cwd, env) =>
    Bun.spawn(argv, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      stdout: 'pipe',
      stderr: 'pipe',
    }) as unknown as SpawnedProc,
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
    // A diferencia de los providers de terminal (sesión persistente — el CLI
    // puede releer el archivo en cualquier momento), acá el proceso es
    // corto: lo borramos apenas termina en vez de dejar un secreto en claro
    // acumulándose en /tmp por cada run.
    let mcpConfigFile: string | undefined
    if (cfg.mcpServers) {
      mcpConfigFile = await writeMcpConfigFile(cfg.mcpServers)
      argv.push('--mcp-config', mcpConfigFile)
    }

    const t0 = Date.now()
    const proc = _claudePrintInternals.spawn(argv, input.cwd, cfg.env)

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
      if (mcpConfigFile) await unlink(mcpConfigFile).catch(() => {})
    }
  }
}
