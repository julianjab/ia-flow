// Shared logic for terminal-based Claude providers (iTerm2 and tmux)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, basename, join } from 'node:path'
import type { StepInput } from './index.js'
import { loadProviderConfig } from './index.js'

export const pexec = promisify(execFile)

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'task'
}

// ─── Resolve a valid git base branch ─────────────────────────────────────

export async function resolveBaseBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5_000 })
    const branch = stdout.trim()
    if (branch && branch !== 'HEAD') return branch
    for (const candidate of ['main', 'master', 'develop']) {
      try {
        await pexec('git', ['-C', repoPath, 'rev-parse', '--verify', candidate], { timeout: 3_000 })
        return candidate
      } catch { /* not found */ }
    }
    return null
  } catch {
    return null
  }
}

// ─── Write prompt to temp file and build claude command ──────────────────

export async function buildClaudeCommand(
  input: StepInput,
  providerId: 'tmux-claude' | 'iterm-claude' = 'tmux-claude',
): Promise<{ cmd: string; promptFile: string }> {
  const promptFile = `/tmp/iaflow-prompt-${Date.now()}.txt`
  const slug = slugify(input.taskTitle)
  const branchName = `feat/${slug}`

  const config = await loadProviderConfig()
  const termDefaults = providerId === 'iterm-claude' ? (config.itermClaude ?? {}) : (config.tmuxClaude ?? {})

  // Per-agent override — narrows the discriminated union to the matching terminal variant.
  const pc = input.providerConfig?.provider === providerId ? input.providerConfig : undefined

  const model    = pc?.model    ?? termDefaults.model
  const maxTurns = pc?.maxTurns ?? termDefaults.maxTurns
  const dsp      = pc?.dangerouslySkipPermissions ?? termDefaults.dangerouslySkipPermissions

  let claudeFlags = ''
  if (model) claudeFlags += ` --model ${model}`
  if (maxTurns) claudeFlags += ` --max-turns ${maxTurns}`
  if (dsp) claudeFlags += ' --dangerously-skip-permissions'

  let cmd = `claude${claudeFlags} < "${promptFile}"`
  let gitContext = ''

  if (input.step === 'implement' && input.cwd) {
    const workflow = input.workflow ?? 'branch'

    if (workflow === 'main') {
      const baseBranch = await resolveBaseBranch(input.cwd)
      gitContext = [
        '## Git context',
        `- Workflow: **main** — commit directly on \`${baseBranch ?? 'main'}\`, no branch needed`,
        `- Repo path: \`${input.cwd}\``,
      ].join('\n')

    } else if (workflow === 'worktree') {
      const baseBranch = await resolveBaseBranch(input.cwd)
      if (baseBranch) {
        const worktreePath = join(dirname(input.cwd), `${basename(input.cwd)}-${slug}`)
        const repo = `"${input.cwd}"`
        const wt = `"${worktreePath}"`
        cmd = `(git -C ${repo} worktree add -b ${branchName} ${wt} ${baseBranch} 2>/dev/null || git -C ${repo} worktree add ${wt} ${branchName}) && cd ${wt} && claude < "${promptFile}"`
        gitContext = [
          '## Git context',
          `- Workflow: **worktree** — you are running inside a git worktree`,
          `- Worktree path: \`${worktreePath}\``,
          `- Branch: \`${branchName}\` (based on \`${baseBranch}\`)`,
          `- Main repo: \`${input.cwd}\``,
          `- When done: push \`${branchName}\` and open a PR against \`${baseBranch}\``,
        ].join('\n')
      }

    } else {
      // branch — checkout in-place
      const baseBranch = await resolveBaseBranch(input.cwd)
      if (baseBranch) {
        cmd = `git checkout -b ${branchName} 2>/dev/null || git checkout ${branchName} && claude < "${promptFile}"`
        gitContext = [
          '## Git context',
          `- Workflow: **branch** — a new branch has been checked out in-place`,
          `- Branch: \`${branchName}\` (based on \`${baseBranch}\`)`,
          `- Repo path: \`${input.cwd}\``,
          `- When done: push \`${branchName}\` and open a PR against \`${baseBranch}\``,
        ].join('\n')
      } else {
        cmd = `claude < "${promptFile}"`
      }
    }
  }

  const fullPrompt = gitContext ? `${gitContext}\n\n${input.prompt}` : input.prompt
  await Bun.write(promptFile, fullPrompt)

  return { cmd, promptFile, env: termDefaults.env ?? {} }
}

