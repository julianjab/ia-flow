// iTerm2 provider — opens Claude CLI directly in an iTerm2 tab (no tmux)
import type { StepInput, StepOutput, StepProvider } from './index.js'
import { buildClaudeCommand, pexec } from './terminal-provider-base.js'

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
): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('iTerm2 provider only works on macOS')

  const escapedCwd = escapeForAppleScript(cwd)
  const envPrefix = Object.keys(env).length ? buildEnvPrefix(env) + ' && ' : ''
  const escapedCmd = escapeForAppleScript(envPrefix + command)

  const script = `
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
          write text "cd \\"${escapedCwd}\\""
          delay 0.3
          write text "${escapedCmd}"
        end tell
      end tell
    end tell
    return "ok"
  `

  await pexec('osascript', ['-e', script], { timeout: 10_000 })
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

export const itermClaudeProvider: StepProvider = {
  id: 'iterm-claude',
  name: 'Claude CLI (iTerm2)',
  description: 'Opens Claude CLI directly in an iTerm2 tab. No tmux required. macOS only.',

  async run(input: StepInput): Promise<StepOutput> {
    const cwd = input.cwd ?? process.cwd()
    const fullPrompt = input.prompt
    const { cmd, env } = await buildClaudeCommand({ ...input, prompt: fullPrompt }, 'iterm-claude')

    await openItermTab(cwd, `${cmd}; exit`, env)
    await setTabTitle(`ia-flow: ${input.taskTitle.slice(0, 40)}`)

    return {
      content: `iTerm2 tab opened. Claude is running in ${cwd}.`,
      mode: 'tmux',
      itermOpened: true,
    }
  },
}
