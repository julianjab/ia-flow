// Shared logic for terminal-based Claude providers (iTerm2 and tmux)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, basename, join } from 'node:path'
import type { StepInput } from './index.js'

export const pexec = promisify(execFile)

export function slugify(s: string): string {  // exported so orchestrator can compute branch/worktree names
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

// ─── Detect GitHub remote URL for a repo ─────────────────────────────────

export async function resolveGithubRemote(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { timeout: 5_000 })
    const url = stdout.trim()
    // Match github.com URLs: https://github.com/owner/repo or git@github.com:owner/repo
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/)
    return match ? match[1].replace(/\.git$/, '') : null
  } catch {
    return null
  }
}

// ─── Write prompt to temp file and build claude command ──────────────────

export async function buildClaudeCommand(input: StepInput): Promise<{ cmd: string; promptFile: string }> {
  const promptFile = `/tmp/iaflow-prompt-${Date.now()}.txt`
  await Bun.write(promptFile, input.prompt)

  const slug = slugify(input.taskTitle)
  const branchName = `feat/${slug}`

  let cmd = `claude < "${promptFile}"`

  if (input.step === 'implement' && input.cwd) {
    const workflow = input.workflow ?? 'branch'

    if (workflow === 'main') {
      // Commit directly on the current branch — no git setup needed
      cmd = `claude < "${promptFile}"`

    } else if (workflow === 'worktree') {
      const baseBranch = await resolveBaseBranch(input.cwd)
      if (baseBranch) {
        const worktreePath = join(dirname(input.cwd), `${basename(input.cwd)}-${slug}`)
        const repo = `"${input.cwd}"`
        const wt = `"${worktreePath}"`
        // Create worktree on a new branch (or reuse if the branch already exists)
        cmd = `(git -C ${repo} worktree add -b ${branchName} ${wt} ${baseBranch} 2>/dev/null || git -C ${repo} worktree add ${wt} ${branchName}) && cd ${wt} && claude < "${promptFile}"`
      }

    } else {
      // branch (default) — checkout in-place
      const baseBranch = await resolveBaseBranch(input.cwd)
      cmd = baseBranch
        ? `git checkout -b ${branchName} 2>/dev/null || git checkout ${branchName} && claude < "${promptFile}"`
        : `claude < "${promptFile}"`
    }
  }

  return { cmd, promptFile }
}

// ─── Callback prompt builder (refine steps only) ─────────────────────────

export function buildPromptWithCallback(input: StepInput): string {
  const isRefine = (input.step as string).startsWith('refine')

  if (!isRefine) return input.prompt  // implement: gh commands already embedded

  if (!input.daemonUrl || !input.issueId || !input.itemId || !input.projectId) return input.prompt

  const payload = {
    step: input.step,
    issueId: input.issueId,
    issueNumber: input.issueNumber,
    issueBody: input.issueBody ?? '',
    taskType: input.taskType,
    repoName: input.repoName,
    itemId: input.itemId,
    projectId: input.projectId,
  }

  return `${input.prompt}

---

Al terminar el refinamiento, llama al daemon con el PRD generado:

\`\`\`bash
curl -s -X POST ${input.daemonUrl}/api/sessions/complete \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ ...payload, prdJson: '<EL_JSON_DEL_PRD_AQUI>' })}'
\`\`\`

Reemplaza \`<EL_JSON_DEL_PRD_AQUI>\` con el JSON completo del PRD (como string escapado).`
}
