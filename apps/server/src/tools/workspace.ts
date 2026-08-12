// Workspace lifecycle tools — expose limited WorkspaceManager operations to
// the agent. Only tools that make sense to invoke *during* a run live here;
// the create / release lifecycle stays owned by AgentOrchestrator.
//
// Consumption model: the manager instance is wired via `setWorkspaceManager`
// from `composition/container.ts` at startup. Tests inject a stub the same
// way and reset with `setWorkspaceManager(null)` in cleanup.

import type { WorkspaceManager } from '../application/WorkspaceManager.js'
import { createLogger } from '../logger.js'
import { registerTool } from './index.js'

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
    'ADVERTENCIA: después de invocar esta herramienta los repoPaths/writePaths ya no apuntan al árbol anterior; cualquier cambio no comiteado se pierde de la vista del agente. Usar sólo para desbloquear un worktree divergente o corrompido.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description:
          'ID del task cuyo worktree hay que resetear. Debe coincidir con el task activo del run.',
      },
    },
    required: ['task_id'],
  },
  async execute(rawInput: unknown): Promise<string> {
    if (!manager) {
      return 'reset_worktree unavailable: WorkspaceManager no está wireado en el runtime'
    }
    const input = (rawInput ?? {}) as ResetWorktreeInput
    const taskId = input.task_id
    if (!taskId) {
      return 'reset_worktree failed: task_id es requerido'
    }
    try {
      const path = await manager.resetWorktree(taskId)
      log.info({ taskId, worktree: path }, 'worktree reset')
      return [
        `Worktree reseteado para task ${taskId}.`,
        `Nuevo path: ${path}.`,
        'Commit(s) previo(s) preservado(s) en git reflog para rescate manual.',
      ].join(' ')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ taskId, err: msg }, 'reset_worktree failed')
      return `reset_worktree failed: ${msg}`
    }
  },
})
