// iTerm2 provider — opens Claude CLI directly in an iTerm2 tab (no tmux)
import type { StepProvider, StepInput, StepOutput } from './index.js'
import { slugify, buildClaudeCommand, buildPromptWithCallback } from './terminal-provider-base.js'
import { pexec } from './terminal-provider-base.js'

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function openItermTab(cwd: string, command: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('iTerm2 provider only works on macOS')

  const escapedCwd = escapeForAppleScript(cwd)
  const escapedCmd = escapeForAppleScript(command)

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
    const fullPrompt = buildPromptWithCallback(input)
    const { cmd } = await buildClaudeCommand({ ...input, prompt: fullPrompt })

    await openItermTab(cwd, `${cmd}; exit`)
    await setTabTitle(`ia-flow: ${input.taskTitle.slice(0, 40)}`)

    return {
      content: `iTerm2 tab opened. Claude is running in ${cwd}.`,
      mode: 'tmux',
      itermOpened: true,
    }
  },
}
