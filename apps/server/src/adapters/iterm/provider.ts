// iTerm2 provider — opens Claude CLI directly in an iTerm2 tab (no tmux)
import type {
  IAgentProvider,
  ProviderInput,
  ProviderOutput,
  SessionHandle,
} from '../../domain/ports/IAgentProvider.js'
import { createLogger } from '../../logger.js'
import { buildClaudeCommand, pexec } from '../terminal-base/base.js'

const log = createLogger('iterm-claude')

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildEnvPrefix(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `export ${k}=${escapeForAppleScript(v)}`)
    .join(' && ')
}

async function openItermTab(
  cwd: string,
  command: string,
  env: Record<string, string> = {},
): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('iTerm2 provider only works on macOS')

  const escapedCwd = escapeForAppleScript(cwd)
  const envPrefix = Object.keys(env).length ? buildEnvPrefix(env) + ' && ' : ''
  const escapedCmd = escapeForAppleScript(envPrefix + command)

  const script = `
    set sid to ""
    tell application "iTerm2"
      activate
      if (count of windows) = 0 then
        set w to (create window with default profile)
      else
        set w to current window
      end if
      tell w
        set t to (create tab with default profile)
        tell current session of t
          set sid to id
          write text "cd \\"${escapedCwd}\\""
          delay 0.3
          write text "${escapedCmd}"
        end tell
      end tell
    end tell
    return sid
  `

  const { stdout } = await pexec('osascript', ['-e', script], { timeout: 10_000 })
  return stdout.trim()
}

async function setTabTitle(title: string): Promise<void> {
  const escaped = escapeForAppleScript(title)
  const script = `
    tell application "iTerm2"
      tell current session of current tab of current window
        set name to "${escaped}"
      end tell
    end tell
  `
  await pexec('osascript', ['-e', script], { timeout: 5_000 }).catch(() => {})
}

async function itermSessionExists(sessionId: string): Promise<boolean> {
  if (process.platform !== 'darwin' || !sessionId) return false
  const escaped = escapeForAppleScript(sessionId)
  // Returns "alive" if the session id is still present in any window/tab,
  // "gone" otherwise. Kept tight so the frequent watchdog poll is cheap.
  const script = `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${escaped}" then return "alive"
          end repeat
        end repeat
      end repeat
    end tell
    return "gone"
  `
  try {
    const { stdout } = await pexec('osascript', ['-e', script], { timeout: 5_000 })
    return stdout.trim() === 'alive'
  } catch {
    // AppleScript timeout / iTerm not running → treat as gone. A run whose
    // host app died can't recover on its own.
    return false
  }
}

/** Build a SessionHandle for a tab already opened via `openItermTab`. */
export function itermSessionHandle(sessionId: string): SessionHandle {
  return {
    kind: 'iterm',
    id: sessionId,
    isAlive: () => itermSessionExists(sessionId),
    close: () => closeItermSession(sessionId),
  }
}

export async function closeItermSession(sessionId: string): Promise<void> {
  if (process.platform !== 'darwin' || !sessionId) return
  const escaped = escapeForAppleScript(sessionId)
  const script = `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${escaped}" then
              close s
            end if
          end repeat
        end repeat
      end repeat
    end tell
  `
  await pexec('osascript', ['-e', script], { timeout: 5_000 }).catch(() => {})
  log.info({ event: 'session.killed', itermSessionId: sessionId }, 'iTerm session closed')
}

export const itermClaudeProvider: IAgentProvider = {
  id: 'iterm-claude',
  name: 'Claude CLI (iTerm2)',
  description: 'Opens Claude CLI directly in an iTerm2 tab. No tmux required. macOS only.',

  async run(input: ProviderInput): Promise<ProviderOutput> {
    const logCtx = {
      runId: input.runId,
      agent: input.agentId,
      projectId: input.projectId,
      taskId: input.taskId,
      task: input.taskTitle,
    }

    const cwd = input.cwd ?? process.cwd()
    const fullPrompt = input.prompt
    const { cmd, env } = await buildClaudeCommand({ ...input, prompt: fullPrompt }, 'iterm-claude')

    const itermSessionId = await openItermTab(cwd, `${cmd}; exit`, env)
    await setTabTitle(`ia-flow: ${input.taskTitle.slice(0, 40)}`)
    log.info(
      { event: 'session.created', ...logCtx, itermSessionId, cwd, cmd },
      'iTerm session opened',
    )

    return {
      content: `iTerm2 tab opened. Claude is running in ${cwd}.`,
      mode: 'tmux',
      session: itermSessionHandle(itermSessionId),
      attachCmd: 'iTerm2 tab',
    }
  },
}
