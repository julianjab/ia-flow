// tmux + Claude CLI provider — spawns visible iTerm sessions via tmux
import { spawn } from 'node:child_process'
import type {
  IAgentProvider,
  ProviderInput,
  ProviderOutput,
} from '../../domain/ports/IAgentProvider.js'
import { buildClaudeCommand, pexec, slugify } from '../terminal-base/base.js'

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
  env: Record<string, string> = {},
): Promise<{ windowId: string }> {
  const { ANTHROPIC_API_KEY: _drop, ...inherited } = process.env
  const childEnv: NodeJS.ProcessEnv = { ...inherited, ...env }

  const loginShell = process.env.SHELL || '/bin/zsh'
  const cmd = [loginShell, '-lc', command]

  await pexec('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd, ...cmd], {
    env: childEnv,
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

export const tmuxClaudeProvider: IAgentProvider = {
  id: 'tmux-claude',
  name: 'Claude CLI (tmux + iTerm)',
  description:
    'Spawns a Claude session in iTerm via tmux. Best for implementation steps you want to monitor.',

  async run(input: ProviderInput): Promise<ProviderOutput> {
    if (!(await tmuxAvailable())) throw new Error('tmux is not installed. Run: brew install tmux')

    const cwd = input.cwd ?? process.cwd()
    const tmuxSession = await pickSessionName(input.taskTitle)

    const fullPrompt = input.prompt
    const { cmd, env } = await buildClaudeCommand({ ...input, prompt: fullPrompt }, 'tmux-claude')
    // Append kill so the session is cleaned up when Claude exits
    const fullCmd = `${cmd}; tmux kill-session -t ${tmuxSession}`
    const { windowId } = await spawnClaude(tmuxSession, cwd, fullCmd, env)
    const itermOpened = await surfaceInIterm(tmuxSession, windowId)

    return {
      content: `Session: ${tmuxSession} — Claude is running in ${cwd}`,
      mode: 'tmux',
      tmuxSession,
      attachCmd: `tmux attach -t ${tmuxSession}`,
      itermOpened,
    }
  },
}
