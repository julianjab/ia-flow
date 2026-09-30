import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmuxLiveness } from './TmuxLauncher.js'

const execFileAsync = promisify(execFile)

/** Dónde corría una sesión del CLI: para encontrarla si quedó huérfana. */
export type SessionRef = { kind: 'tmux'; name: string } | { kind: 'pid'; pid: number }

/**
 * Cierra la sesión que quedó de un proceso anterior del runner, si sigue viva. Pasa al retomar
 * tras un reinicio: el MCP y los hooks de esa sesión murieron con el runner viejo, así que no
 * puede cerrar su turno — y retomar su conversación mientras sigue corriendo serían dos
 * procesos sobre la misma. Nunca tira: una sesión que no se encuentra ya no molesta.
 */
export async function closeOrphan(ref: SessionRef): Promise<boolean> {
  try {
    if (ref.kind === 'tmux') {
      if ((await tmuxLiveness(ref.name)) !== 'alive') return false
      await execFileAsync('tmux', ['kill-session', '-t', `=${ref.name}`], { timeout: 10_000 })
      return true
    }
    // Un pid se reusa: sólo si ese proceso sigue siendo un `claude`.
    const { stdout } = await execFileAsync('ps', ['-p', String(ref.pid), '-o', 'command='], {
      timeout: 10_000,
    })
    if (!/\bclaude\b/.test(stdout)) return false
    process.kill(ref.pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}
