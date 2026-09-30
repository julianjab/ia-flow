import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServerRef } from '@ia-flow/agent-engine'
import type { ClaudeCliConfig, ClaudeCliMode } from './config.js'
import type { RunEndpoints } from './RunServer.js'
import { writeSessionFiles } from './SessionFiles.js'
import type { CliSession, Launcher } from './sessions/CliSession.js'
import { PrintLauncher } from './sessions/PrintLauncher.js'
import { TmuxLauncher } from './sessions/TmuxLauncher.js'

/** Lo que hace falta para lanzar una sesión del CLI contra el canal de una corrida. */
export interface CliLaunchSpec {
  /** Dónde le habla la sesión a su corrida: el servidor local del provider, o la API de un runner
   *  (un host remoto). La sesión no distingue: son dos URLs con el token en el path. */
  endpoints: RunEndpoints
  /** El worktree de la task. */
  cwd: string
  /** `<agente>-task-<n>`: el nombre de la sesión (`tmux ls`). */
  label: string
  /** El prompt del turno: el del agente, o lo que pasó si se retoma. */
  prompt: string
  systemPrompts: string[]
  /** Las tools terminales, para la nota de sesión desatendida. */
  exits: string[]
  /** Los MCP externos del agente (`github-mcp`, …). */
  mcpServers: McpServerRef[]
  /** La config ya mezclada (provider + agente). */
  config: ClaudeCliConfig
  /** Una sesión nueva con ese id, o retomar la que tiene ese id. */
  session: { id: string; resume: boolean }
  /** Default: `claude`. */
  bin?: string
  /** Cómo se lanza cada modo (tests). */
  launchers?: Partial<Record<ClaudeCliMode, Launcher>>
}

export interface LaunchedCli {
  session: CliSession
  /** Borra los archivos de la sesión (llevan tokens). */
  cleanup(): Promise<void>
}

/**
 * Lanza una sesión del CLI `claude` apuntando al canal de una corrida — sin crearlo: el canal (las
 * tools por MCP, los hooks) es de quien espera el resultado. Lo usan el `ClaudeCliProvider` (canal
 * en su servidor local) y un host remoto (canal en la API del runner que le dio la tarea).
 */
export async function launchCli(spec: CliLaunchSpec): Promise<LaunchedCli> {
  const files = await writeSessionFiles({
    endpoints: spec.endpoints,
    systemPrompts: spec.systemPrompts,
    exits: spec.exits,
    mcpServers: spec.mcpServers,
    env: credentialEnv(spec.config.env ?? {}),
    ...(spec.config.model ? { model: spec.config.model } : {}),
    args: spec.config.args ?? [],
    session: spec.session,
  })
  try {
    const promptFile = join(files.dir, 'prompt.md')
    await writeFile(promptFile, spec.prompt, { mode: 0o600 })
    const mode = spec.config.mode ?? 'print'
    const launcher =
      spec.launchers?.[mode] ?? (mode === 'tmux' ? new TmuxLauncher() : new PrintLauncher())
    const session = await launcher.launch({
      bin: spec.bin ?? 'claude',
      argv: files.argv,
      promptFile,
      cwd: spec.cwd,
      label: spec.label,
      ...(spec.config.surface ? { surface: true } : {}),
    })
    return { session, cleanup: () => files.cleanup() }
  } catch (error) {
    await files.cleanup().catch(() => {})
    throw error
  }
}

/** La credencial OAuth del CLI viaja en el `--settings`, no en el shell. */
function credentialEnv(env: Record<string, string>): Record<string, string> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
  return token && !env.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: token, ...env } : env
}
