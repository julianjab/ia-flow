import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  type CliSession,
  cliEnv,
  type Launcher,
  type LaunchSpec,
  type SessionExit,
} from './CliSession.js'
import { acceptTrustDialog } from './trustDialog.js'

const execFileAsync = promisify(execFile)

/** `execFile` bajo Bun tira SINCRÓNICAMENTE si no puede lanzar el proceso (binario fuera del
 *  PATH): se normaliza a un rechazo, que es lo que cada llamada sabe manejar. */
function run(bin: string, args: string[], env?: NodeJS.ProcessEnv) {
  try {
    return execFileAsync(bin, args, { timeout: 10_000, ...(env ? { env } : {}) })
  } catch (error) {
    return Promise.reject(error)
  }
}

export type Liveness = 'alive' | 'dead' | 'unknown'

/** `tmux has-session`: si tmux contestó que no existe (exit 1) está muerta; si no pudimos ni
 *  preguntar (sin binario, timeout) no sabemos — y una hipo del host no mata una corrida viva. */
export async function tmuxLiveness(name: string): Promise<Liveness> {
  try {
    await run('tmux', ['has-session', '-t', `=${name}`])
    return 'alive'
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; signal?: unknown }
    const probeFailed =
      failure.killed === true || failure.signal != null || typeof failure.code !== 'number'
    return probeFailed ? 'unknown' : 'dead'
  }
}

/** Una comilla simple de shell alrededor de cada argumento. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** `iaflow-<label>` apto para tmux: sin `:` ni `.` (separan sesión, ventana y panel). */
export function sessionName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `iaflow-${slug || 'task'}`
}

export interface TmuxLauncherOptions {
  /** Cada cuánto se mira si la sesión sigue viva. Default: 3 s. */
  pollMs?: number
  /** Cuánto se mira el panel al arrancar por si aparece el diálogo de confianza del CLI
   *  (`trustDialog.ts`). Default: 30 s; `0` no lo mira. */
  trustWatchMs?: number
}

/**
 * La sesión interactiva del CLI en tmux (`iaflow-<agente>-task-<n>`): corre igual que `print`,
 * pero un humano puede mirarla (`tmux attach -t …`) o, con `surface`, verla en una pestaña de
 * iTerm. El prompt entra como argumento y el shell es de login (`$SHELL -lc`), con
 * `ANTHROPIC_API_KEY` borrada: el perfil del usuario suele volver a exportarla. Si el CLI abre con
 * el diálogo de confianza del worktree (nuevo en cada task), se acepta solo (`trustDialog.ts`).
 */
export class TmuxLauncher implements Launcher {
  constructor(private readonly options: TmuxLauncherOptions = {}) {}

  async launch(spec: LaunchSpec): Promise<CliSession> {
    const name = await this.freeName(sessionName(spec.label))
    const claude = [spec.bin, ...spec.argv].map(shellQuote).join(' ')
    const command = `unset ANTHROPIC_API_KEY; ${claude} "$(cat ${shellQuote(spec.promptFile)})"`
    const shell = process.env.SHELL || '/bin/zsh'
    await run(
      'tmux',
      ['new-session', '-d', '-s', name, '-c', spec.cwd, shell, '-lc', command],
      cliEnv(),
    )
    if (spec.surface) await surfaceInIterm(name)
    const watching = new AbortController()
    const trustWatchMs = this.options.trustWatchMs ?? 30_000
    if (trustWatchMs > 0) {
      const target = `=${name}:`
      void acceptTrustDialog({
        capture: async () =>
          (await run('tmux', ['capture-pane', '-p', '-t', target])).stdout.toString(),
        confirm: async () => {
          await run('tmux', ['send-keys', '-t', target, 'Enter'])
        },
        timeoutMs: trustWatchMs,
        signal: watching.signal,
      })
    }
    let stopped = false
    const exited = new Promise<SessionExit>((resolve) => {
      const poll = async () => {
        if (stopped) return resolve({ code: null, output: '' })
        if ((await tmuxLiveness(name)) === 'dead') return resolve({ code: null, output: '' })
        setTimeout(poll, this.options.pollMs ?? 3_000).unref?.()
      }
      void poll()
    })
    return {
      exited,
      describe: `tmux attach -t ${name}`,
      ref: { kind: 'tmux', name },
      close: async () => {
        stopped = true
        watching.abort()
        await run('tmux', ['kill-session', '-t', `=${name}`]).catch(() => {})
      },
    }
  }

  /** El nombre, o con sufijo si ya hay una sesión viva con él. */
  private async freeName(base: string): Promise<string> {
    if ((await tmuxLiveness(base)) !== 'alive') return base
    for (let i = 2; i < 50; i++) {
      if ((await tmuxLiveness(`${base}-${i}`)) !== 'alive') return `${base}-${i}`
    }
    return `${base}-${Date.now()}`
  }
}

/** Abre una pestaña de iTerm enganchada a la sesión (macOS; si falla, la sesión sigue igual). */
async function surfaceInIterm(name: string): Promise<void> {
  if (process.platform !== 'darwin') return
  const attach = `tmux attach -t ${name}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = [
    'tell application "iTerm"',
    '  activate',
    '  if (count of windows) = 0 then',
    '    set s to current session of (create window with default profile)',
    '  else',
    '    tell current window to set s to current session of (create tab with default profile)',
    '  end if',
    `  tell s to write text "${attach}"`,
    'end tell',
  ].join('\n')
  await run('osascript', ['-e', script]).catch(() => {})
}
