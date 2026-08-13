// Workspace lifecycle tools — expose limited WorkspaceManager operations to
// the agent. Only tools that make sense to invoke *during* a run live here;
// the create / release lifecycle stays owned by AgentOrchestrator.
//
// Consumption model: the manager instance is wired via `setWorkspaceManager`
// from `composition/container.ts` at startup. Tests inject a stub the same
// way and reset with `setWorkspaceManager(null)` in cleanup.

import type { WorkspaceManager } from '../application/WorkspaceManager.js'
import { createLogger } from '../logger.js'
import { type ToolContext, registerTool } from './index.js'

const log = createLogger('tool-workspace')

let manager: WorkspaceManager | null = null

/**
 * Wires the `WorkspaceManager` singleton this module's tools operate on.
 * Called from `composition/container.ts` at startup, and from tests with a
 * stub / null (to reset between cases).
 */
export function setWorkspaceManager(m: WorkspaceManager | null): void {
  manager = m
}

/** Test/introspection helper. */
export function getWorkspaceManager(): WorkspaceManager | null {
  return manager
}

interface ResetWorktreeInput {
  /** Optional — defaults to `ctx.taskId` (wired by the anthropic-api provider). */
  task_id?: string
}

registerTool({
  name: 'reset_worktree',
  // Sync-only: the WorkspaceManager sandbox (worktree + writePaths) is only
  // built for the anthropic-api provider. Terminal providers (tmux/iterm)
  // don't have a task-scoped worktree, so exposing this tool there would be
  // a footgun. `providerKinds: ['sync']` keeps it out of the curl appendix
  // that terminal providers assemble via `buildToolInstructions`.
  providerKinds: ['sync'],
  description: [
    'Descarta la rama task/<id> del task actual y recrea el worktree limpio desde origin/main.',
    'El commit previo queda accesible en el reflog local (`git reflog show task/<id>`) para rescate manual, pero deja de ser alcanzable desde cualquier ref.',
    'Solo disponible en fases con escritura habilitada (writePaths no vacío).',
    'ADVERTENCIA: después de invocar esta herramienta los repoPaths/writePaths ya no apuntan al árbol anterior; cualquier cambio no comiteado se pierde de la vista del agente. Usar sólo para desbloquear un worktree divergente o corrompido.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description:
          'Opcional. ID del task cuyo worktree hay que resetear. Si se omite, se usa el task activo del run (ctx.taskId).',
      },
    },
  },
  async execute(rawInput: unknown, ctx: ToolContext): Promise<string> {
    // Shared guard with run_command: no writable zone → we're in a read-only
    // phase (Refine/Test), so mutating the worktree is not allowed.
    if (!ctx.writePaths || ctx.writePaths.length === 0) {
      return 'Error: escritura no permitida en fase actual'
    }
    if (!manager) {
      return 'reset_worktree unavailable: WorkspaceManager no está wireado en el runtime'
    }
    const input = (rawInput ?? {}) as ResetWorktreeInput
    const taskId = input.task_id ?? ctx.taskId
    if (!taskId) {
      return 'reset_worktree failed: task_id es requerido (ausente en input y en ctx.taskId)'
    }
    try {
      const { path, previousHead, newHead } = await manager.resetWorktree(taskId)
      log.info({ taskId, worktree: path, previousHead, newHead }, 'worktree reset')
      const prior = previousHead ?? '(no había HEAD previo)'
      return [
        `Worktree reseteado para task ${taskId}.`,
        `Nuevo path: ${path}.`,
        `HEAD previo: ${prior}. Nuevo HEAD: ${newHead}.`,
        `Commit previo preservado en git reflog (\`git reflog show task/${taskId}\`) para rescate manual.`,
      ].join(' ')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ taskId, err: msg }, 'reset_worktree failed')
      return `reset_worktree failed: ${msg}`
    }
  },
})
