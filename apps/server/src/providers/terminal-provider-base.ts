// Shared logic for terminal-based Claude providers (iTerm2 and tmux)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { StepInput } from './index.js'

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

export async function buildClaudeCommand(input: StepInput): Promise<{ cmd: string; promptFile: string }> {
  const promptFile = `/tmp/iaflow-prompt-${Date.now()}.txt`
  await Bun.write(promptFile, input.prompt)

  const slug = slugify(input.taskTitle)
  const branchName = `feat/${slug}`

  let cmd = `claude < ${promptFile}`
  if (input.step === 'implement') {
    const baseBranch = input.cwd ? await resolveBaseBranch(input.cwd) : null
    cmd = baseBranch
      ? `claude --worktree ${branchName} < ${promptFile}`
      : `git checkout -b ${branchName} && claude < ${promptFile}`
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
