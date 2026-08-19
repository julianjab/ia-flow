// tmux + Claude CLI provider — spawns visible iTerm sessions via tmux
import { spawn } from 'node:child_process'
import type {
  IAgentProvider,
  ProviderInput,
  ProviderOutput,
  SessionHandle,
} from '../../contract.js'
import { type TerminalBaseDeps, createTerminalBase, pexec, slugify } from '../base.js'

const SESSION_PREFIX = 'iaflow'

// ─── tmux helpers ─────────────────────────────────────────────────────────

async function tmuxAvailable(): Promise<boolean> {
  try {
    await pexec('tmux', ['-V'])
    return true
  } catch {
    return false
  }
}

async function sessionExists(name: string): Promise<boolean> {
  try {
    await pexec('tmux', ['has-session', '-t', `=${name}`])
    return true
  } catch {
    return false
  }
}

async function killSession(name: string): Promise<void> {
  try {
    spawn('tmux', ['kill-session', '-t', name], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* nothing to kill */
  }
}

/** Build a SessionHandle over an already-spawned tmux session. */
export function tmuxSessionHandle(name: string): SessionHandle {
  return {
    kind: 'tmux',
    id: name,
    isAlive: () => sessionExists(name),
    close: () => killSession(name),
  }
}

async function pickSessionName(preferred: string): Promise<string> {
  const base = `${SESSION_PREFIX}-${slugify(preferred)}`
  if (!(await sessionExists(base))) return base
  for (let i = 2; i < 50; i++) {
    const c = `${base}-${i}`
    if (!(await sessionExists(c))) return c
  }
  return `${base}-${Date.now()}`
}

// ─── Surface session in iTerm ──────────────────────────────────────────────

async function surfaceInIterm(tmuxSession: string, windowId: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    const { stdout } = await pexec('tmux', [
      'list-clients',
      '-t',
      tmuxSession,
      '-F',
      '#{client_tty} #{client_termname}',
    ])
    const itermClient = stdout.split('\n').find((l) => l.includes('iterm') || l.includes('xterm'))

    if (itermClient) {
      const tty = itermClient.trim().split(' ')[0]
      spawn('tmux', ['switch-client', '-c', tty, '-t', `${tmuxSession}:${windowId}`], {
        detached: true,
        stdio: 'ignore',
      }).unref()
      spawn('osascript', ['-e', 'tell application "iTerm" to activate'], {
        detached: true,
        stdio: 'ignore',
      }).unref()
      return true
    }

    const attach = `tmux attach -t ${tmuxSession}`
    const escaped = attach.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script = [
      'tell application "iTerm"',
      '  activate',
      '  if (count of windows) = 0 then',
      '    set w to (create window with default profile)',
      '    set s to current session of w',
      '  else',
      '    tell current window',
      '      set t to (create tab with default profile)',
      '    end tell',
      '    set s to current session of t',
      '  end if',
      '  delay 0.4',
      `  tell s to write text "${escaped}"`,
      'end tell',
    ].join('\n')
    await pexec('osascript', ['-e', script], { timeout: 8_000 })
    return true
  } catch (e) {
    console.error('[tmux-claude] surfaceInIterm failed:', (e as Error).message)
    return false
  }
}

// ─── Spawn Claude in tmux ─────────────────────────────────────────────────

async function spawnClaude(
  tmuxSession: string,
  cwd: string,
  command: string,
): Promise<{ windowId: string }> {
  // Env vars del terminal ya no se propagan por process env — viven en el
  // settings.json que buildClaudeCommand pasa via `--settings`. Solo dropeamos
  // ANTHROPIC_API_KEY del padre para que OAuth token (en settings.env) gane.
  const { ANTHROPIC_API_KEY: _drop, ...inherited } = process.env

  const loginShell = process.env.SHELL || '/bin/zsh'
  const cmd = [loginShell, '-lc', command]

  await pexec('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd, ...cmd], {
    env: inherited,
  })

  const { stdout } = await pexec('tmux', ['list-windows', '-t', tmuxSession, '-F', '#{window_id}'])
  const windowId =
    stdout
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''

  return { windowId }
}

// ─── Provider ─────────────────────────────────────────────────────────────

export interface TmuxClaudeProviderDeps {
  terminalBase: TerminalBaseDeps
  log: {
    info: (obj: object, msg?: string) => void
    error: (obj: object, msg?: string) => void
  }
}

export class TmuxClaudeProvider implements IAgentProvider {
  readonly id = 'tmux-claude'
  readonly kind = 'async' as const
  readonly name = 'Claude CLI (tmux + iTerm)'
  readonly description =
    'Spawns a Claude session in iTerm via tmux. Best for implementation steps you want to monitor.'

  private readonly buildClaudeCommand: ReturnType<typeof createTerminalBase>['buildClaudeCommand']
  private readonly log: TmuxClaudeProviderDeps['log']

  constructor(deps: TmuxClaudeProviderDeps) {
    this.buildClaudeCommand = createTerminalBase(deps.terminalBase).buildClaudeCommand
    this.log = deps.log
  }

  async run(input: ProviderInput): Promise<ProviderOutput> {
    const log = this.log
    const logCtx = {
      runId: input.runId,
      agent: input.agentId,
      projectId: input.projectId,
      taskId: input.taskId,
      task: input.taskTitle,
    }

    if (!(await tmuxAvailable())) {
      log.error({ event: 'session.error', ...logCtx }, 'tmux is not installed')
      throw new Error('tmux is not installed. Run: brew install tmux')
    }

    const cwd = input.cwd ?? process.cwd()
    const tmuxSession = await pickSessionName(input.taskTitle)
    log.info({ event: 'session.picking', ...logCtx, tmuxSession, cwd }, 'Picked tmux session name')

    const fullPrompt = input.prompt
    const { cmd } = await this.buildClaudeCommand({ ...input, prompt: fullPrompt }, 'tmux-claude')
    // Append kill so the session is cleaned up when Claude exits
    const fullCmd = `${cmd}; tmux kill-session -t ${tmuxSession}`
    const { windowId } = await spawnClaude(tmuxSession, cwd, fullCmd)
    log.info(
      { event: 'session.created', ...logCtx, tmuxSession, windowId, cmd },
      'tmux session created',
    )
    const itermOpened = await surfaceInIterm(tmuxSession, windowId)
    log.info(
      { event: 'session.surfaced', ...logCtx, tmuxSession, itermOpened },
      itermOpened ? 'tmux session surfaced in iTerm' : 'tmux session running headless',
    )

    return {
      content: `Session: ${tmuxSession} — Claude is running in ${cwd}`,
      mode: 'tmux',
      session: tmuxSessionHandle(tmuxSession),
      attachCmd: `tmux attach -t ${tmuxSession}`,
    }
  }
}
