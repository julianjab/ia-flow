/**
 * Dónde escribe el runner lo que es de ESTA máquina: la base (ejecuciones, eventos, trazas), los
 * workspaces de las tasks y lo que dejen sus MCP propios (la memoria). Un solo directorio, fuera de
 * cualquier repo: `IA_FLOW_HOME`, o `~/.local/state/ia-flow/runner`. En un contenedor, el volumen
 * (`IA_FLOW_HOME=/state`).
 *
 *   <home>/runner.sqlite   engine.executions.path, si runner.yaml no la fija
 *   <home>/workspaces/     WORKSPACE_DIR, si el env no lo fija
 *
 * La config (`runner.yaml`) sólo NOMBRA rutas; nunca se escribe al lado de ella.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_RUNNER_HOME = join(homedir(), '.local', 'state', 'ia-flow', 'runner')

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

/** `IA_FLOW_HOME` (con `~` expandido), o el default. */
export function runnerHome(env: Record<string, string | undefined> = process.env): string {
  const value = env.IA_FLOW_HOME?.trim()
  return value ? expandHome(value) : DEFAULT_RUNNER_HOME
}

/** La base del runner si runner.yaml no fija `engine.executions.path`. */
export const defaultDatabasePath = (home = runnerHome()) => join(home, 'runner.sqlite')

/** Los clones y worktrees si el env no fija `WORKSPACE_DIR`. */
export const defaultWorkspaceRoot = (home = runnerHome()) => join(home, 'workspaces')

/** Los de un host (`--host`) si el env no fija `WORKSPACE_DIR`: una raíz aparte de la del runner.
 *  El host borra los worktrees que arma; si compartiera la raíz con un runner en la misma máquina,
 *  la misma task tendría el mismo path en los dos y el host podría borrarle uno en uso. */
export const defaultHostWorkspaceRoot = (home = runnerHome()) => join(home, 'host-workspaces')
