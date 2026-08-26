// iTerm2 provider — opens Claude CLI directly in an iTerm2 tab (no tmux)
import { EMPTY_WORKSPACE_PLAN } from '@ia-flow/shared'
import type { WorkspacePlan, WorkspaceRequest } from '@ia-flow/shared'
import type {
  IAgentProvider,
  Liveness,
  ProviderInput,
  ProviderOutput,
  SessionHandle,
  WorkspaceProvisionerPort,
} from '../../contract.js'
import { type TerminalBaseDeps, createTerminalBase, itermTabTitle, pexec } from '../base.js'

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Builds the AppleScript used to open a tab in iTerm2 and run `command` in it.
 * Deliberately omits `activate` — Apple Events (create window/tab, write text)
 * don't need iTerm2 in the foreground to run against an already-running
 * instance, and `activate` is what steals OS focus from whatever app the
 * user has active on the machine running the daemon.
 */
export function buildOpenItermTabScript(cwd: string, command: string): string {
  const escapedCwd = escapeForAppleScript(cwd)
  const escapedCmd = escapeForAppleScript(command)

  return `
    set sid to ""
    tell application "iTerm2"
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
}

async function openItermTab(cwd: string, command: string): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('iTerm2 provider only works on macOS')

  const script = buildOpenItermTabScript(cwd, command)
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

/**
 * Tres respuestas, no dos: el script contesta "alive"/"gone" cuando iTerm
 * pudo mirar sus ventanas — eso es evidencia. Un AppleScript que no corre
 * (timeout, iTerm ocupado, la máquina no es macOS) no dice nada sobre la
 * sesión, y darla por muerta ahí abandona runs vivos. Ver `Liveness` en
 * ../../contract.ts.
 */
export async function itermLiveness(sessionId: string): Promise<Liveness> {
  if (process.platform !== 'darwin' || !sessionId) return 'unknown'
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
    return stdout.trim() === 'alive' ? 'alive' : 'dead'
  } catch {
    return 'unknown'
  }
}

/** Build a SessionHandle for a tab already opened via `openItermTab`. */
export function itermSessionHandle(sessionId: string): SessionHandle {
  return {
    kind: 'iterm',
    id: sessionId,
    liveness: () => itermLiveness(sessionId),
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
}

export interface ItermClaudeProviderDeps {
  terminalBase: TerminalBaseDeps
  /** Ver `TmuxClaudeProviderDeps.workspace`. */
  workspace?: WorkspaceProvisionerPort
  log: {
    info: (obj: object, msg?: string) => void
  }
}

export class ItermClaudeProvider implements IAgentProvider {
  readonly id = 'iterm-claude'
  readonly kind = 'async' as const
  readonly name = 'Claude CLI (iTerm2)'
  readonly description = 'Opens Claude CLI directly in an iTerm2 tab. No tmux required. macOS only.'

  private readonly buildClaudeCommand: ReturnType<typeof createTerminalBase>['buildClaudeCommand']
  private readonly log: ItermClaudeProviderDeps['log']

  private readonly workspace?: WorkspaceProvisionerPort

  constructor(deps: ItermClaudeProviderDeps) {
    this.buildClaudeCommand = createTerminalBase(deps.terminalBase).buildClaudeCommand
    this.workspace = deps.workspace
    this.log = deps.log
  }

  async prepareWorkspace(req: WorkspaceRequest): Promise<WorkspacePlan> {
    return this.workspace ? this.workspace.prepare(req) : EMPTY_WORKSPACE_PLAN
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

    const cwd = input.cwd ?? process.cwd()
    const fullPrompt = input.prompt
    const { cmd } = await this.buildClaudeCommand({ ...input, prompt: fullPrompt }, 'iterm-claude')

    const itermSessionId = await openItermTab(cwd, `${cmd}; exit`)
    await setTabTitle(itermTabTitle(input))
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
  }
}
