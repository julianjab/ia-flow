// Engine-provided git context prepended to every agent prompt.
//
// The intent: agents should NOT decide branching strategy themselves. El
// provider ya preparó el terreno (`prepareWorkspace`) antes de que el agente
// arranque; este módulo sólo RENDERIZA ese plan como un bloque markdown, para
// que el agente no tenga que correr `git branch --show-current` ni adivinar
// nombres.
//
// Describe lo que pasó, no lo predice: los paths salen del `WorkspacePlan`
// que devolvió el provider, no de recalcular la convención por acá. Cuando
// este archivo derivaba el path por su cuenta y el provider lo derivaba por
// el suyo, cualquier divergencia terminaba en un prompt que le afirmaba al
// agente estar en un worktree donde no estaba.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IAgentProvider } from '@ia-flow/ai-providers'
import { branchNameFor } from '@ia-flow/workspace'

// Inlined (no dependemos de terminal-base para evitar ciclo:
// git-context ← AgentOrchestrator, y terminal-base → application/provider-config →
// composition/container → AgentOrchestrator).
const pexec = promisify(execFile)
async function resolveBaseBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 5_000,
    })
    const branch = stdout.trim()
    if (branch && branch !== 'HEAD') return branch
  } catch {
    /* fall through */
  }
  for (const candidate of ['main', 'master', 'develop']) {
    try {
      await pexec('git', ['-C', cwd, 'rev-parse', '--verify', candidate], { timeout: 3_000 })
      return candidate
    } catch {
      /* not found */
    }
  }
  return null
}

export interface GitContextOptions {
  taskId: string
  /**
   * El IAgentProvider que va a correr el agente. `provider.kind` decide la
   * rama de comportamiento ('sync' = anthropic-api, worktree materializado
   * por el engine; 'async' = terminal/tmux/iterm, obedece repo.workflow).
   * `provider.id` se usa para el texto del bloque en vez de un literal fijo,
   * así un futuro provider sync/async adicional no requiere tocar este
   * archivo.
   */
  provider: IAgentProvider
  /** Dónde arranca el agente — `WorkspacePlan.cwd`. Puede ser el worktree. */
  cwd?: string
  /** Terminal only: 'main' | 'branch' | 'worktree'. Ignored for sync providers. */
  workflow?: 'main' | 'branch' | 'worktree'
  /** `WorkspacePlan.worktreePath`: seteado sólo si se materializó uno. */
  worktreePath?: string
  /**
   * Clone base del repo. La base branch se resuelve SIEMPRE contra este path,
   * nunca contra `cwd`: adentro de un worktree, `rev-parse --abbrev-ref HEAD`
   * devuelve la branch de la task, no la base.
   */
  repoBasePath?: string
  /** sync only: whether the agent can write. Read-only agents skip the "push/PR" line. */
  hasWriteAccess?: boolean
  /**
   * Nombre explícito de la branch (típicamente `task.branch` — linked branch
   * de GitHub o auto-nombrada por Claude). Si viene, gana sobre `task/<id>`.
   */
  branch?: string
}

/**
 * Renders the git-context markdown block for a single agent run.
 *
 * Returns an empty string when there is nothing meaningful to say (no cwd,
 * or a step that shouldn't include git context). Callers prepend the
 * returned string to the agent's user prompt.
 */
export async function buildGitContext(opts: GitContextOptions): Promise<string> {
  const { taskId, provider, cwd, workflow, worktreePath, hasWriteAccess } = opts
  const branch = branchNameFor(taskId, opts.branch)
  const repoBase = opts.repoBasePath ?? cwd

  if (provider.kind === 'sync') {
    if (!cwd || !repoBase) return ''
    const baseBranch = (await resolveBaseBranch(repoBase)) ?? 'main'
    if (worktreePath) {
      return [
        '## Git context',
        `- Provider: **${provider.id}** — worktree materializado por el engine (no crear branches manualmente).`,
        `- Branch: \`${branch}\` (based on \`${baseBranch}\`)`,
        `- Worktree path: \`${worktreePath}\``,
        `- When done: push \`${branch}\` y abrí PR contra \`${baseBranch}\` (usa el tool de GitHub MCP si está disponible).`,
      ].join('\n')
    }
    // Read-only agent (no writePaths) — read desde el base repo.
    return [
      '## Git context',
      `- Provider: **${provider.id}** (read-only).`,
      `- Read path: \`${cwd}\`.`,
      hasWriteAccess === false
        ? `- Sin write tools — no toques git. Si necesitás ver lo que un builder previo dejó, mirá commits en \`${branch}\`.`
        : `- Branch nominal: \`${branch}\`.`,
    ].join('\n')
  }

  // provider.kind === 'async' (terminal: tmux/iterm)
  if (!cwd || !repoBase) return ''
  if (workflow === 'main') {
    const baseBranch = (await resolveBaseBranch(repoBase)) ?? 'main'
    return [
      '## Git context',
      `- Workflow: **main** — commit directly on \`${baseBranch}\`, no branch needed.`,
      `- Repo path: \`${cwd}\`.`,
    ].join('\n')
  }
  // Nunca dejamos el bloque vacío por un fallo transitorio de git; caemos a 'main'.
  const baseBranch = (await resolveBaseBranch(repoBase)) ?? 'main'
  if (workflow === 'worktree' && worktreePath) {
    return [
      '## Git context',
      // `prepareWorkspace` ya materializó el worktree y dejó la sesión
      // arrancando adentro (no hay flag `--worktree` ni hook de por medio),
      // así que este path es exactamente donde corre.
      `- Workflow: **worktree** — ia-flow created this worktree before the session started.`,
      `- Worktree path: \`${worktreePath}\` (you are already inside it).`,
      `- Branch: \`${branch}\` (based on \`${baseBranch}\`).`,
      `- Main repo: \`${repoBase}\`.`,
      `- When done: push \`${branch}\` and open a PR against \`${baseBranch}\`.`,
    ].join('\n')
  }
  // default: branch (in-place)
  return [
    '## Git context',
    `- Workflow: **branch** — a new branch has been checked out in-place.`,
    `- Branch: \`${branch}\` (based on \`${baseBranch}\`).`,
    `- Repo path: \`${cwd}\`.`,
    `- When done: push \`${branch}\` and open a PR against \`${baseBranch}\`.`,
  ].join('\n')
}
