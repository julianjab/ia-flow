// Workspace lifecycle tools — expose limited WorkspaceManager operations to
// the agent. Only tools that make sense to invoke *during* a run live here;
// the create / release lifecycle stays owned by AgentOrchestrator.
//
// Consumption model: the manager instance is wired via `setWorkspaceManager`
// from `composition/container.ts` at startup. Tests inject a stub the same
// way and reset with `setWorkspaceManager(null)` in cleanup.

import type { ToolContext, WorkspaceManagerPort } from '../contract.js'
import { registerTool } from '../engine.js'
import { clearRangeCoverage } from '../fs/fs.js'
import { createLogger } from '../logger.js'

const log = createLogger('tool-workspace')

let manager: WorkspaceManagerPort | null = null

/**
 * Wires the `WorkspaceManager` singleton this module's tools operate on.
 * Called from `composition/container.ts` at startup, and from tests with a
 * stub / null (to reset between cases).
 */
export function setWorkspaceManagerPort(m: WorkspaceManagerPort | null): void {
  manager = m
}

/** Test/introspection helper. */
export function getWorkspaceManagerPort(): WorkspaceManagerPort | null {
  return manager
}

interface ResetWorktreeInput {
  task_id?: string
}

registerTool({
  name: 'workspace_reset',
  aliases: ['reset_worktree'],
  // Sync-only: the WorkspaceManager sandbox (worktree + writePaths) is only
  // built for the anthropic-api provider. Terminal providers (tmux/iterm)
  // don't have a task-scoped worktree, so exposing this tool there would be
  // a footgun. `providerKinds: ['sync']` keeps it out of the MCP tool list
  // terminal providers get via /api/mcp.
  providerKinds: ['sync'],
  // Documentation marker: same rationale as write_file / edit_file / run_command
  // — depends on the anthropic-api-built sandbox (worktree + writePaths).
  // The functional filter is `providerKinds` above; this flag makes the
  // intent explicit at the registration site.
  apiOnly: true,
  description: [
    'Descarta la rama task/<id> del task actual y recrea el worktree limpio desde origin/main.',
    'Input puede venir vacío `{}` — el task_id se deriva del contexto del run; si el agente quiere ser explícito puede pasarlo igual.',
    'Sólo disponible cuando el run tiene worktree writable (writePaths no vacío); en modo read-only devuelve error explícito.',
    'El commit previo queda accesible en el reflog local (`git reflog show task/<id>`) para rescate manual, pero deja de ser alcanzable desde cualquier ref.',
    'La respuesta incluye el hash previo (para poder pescarlo del reflog) y el nuevo HEAD tras el reset a origin/main.',
    'ADVERTENCIA: después de invocar esta herramienta los repoPaths/writePaths ya no apuntan al árbol anterior; cualquier cambio no comiteado se pierde de la vista del agente. Usar sólo para desbloquear un worktree divergente o corrompido.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description:
          'ID del task cuyo worktree hay que resetear. Opcional — si se omite, se toma del contexto del run.',
      },
    },
    // Deliberately empty: the agent can call with `{}` and we resolve
    // task_id from the run context. Keeping task_id in `properties` (but
    // not `required`) lets an operator override for debugging via the raw
    // HTTP endpoint without changing the schema.
    required: [],
  },
  async execute(rawInput: unknown, ctx: ToolContext): Promise<string> {
    // Write-tool guard: mismo mensaje que write_file / edit_file usan para
    // que operadores / observers puedan grepear por una sola cadena.
    if (!ctx.writePaths || ctx.writePaths.length === 0) {
      return 'reset_worktree failed: escritura no permitida en fase actual'
    }
    if (!manager) {
      return 'reset_worktree unavailable: WorkspaceManager no está wireado en el runtime'
    }
    const input = (rawInput ?? {}) as ResetWorktreeInput
    const taskId = input.task_id ?? ctx.taskId
    if (!taskId) {
      return 'reset_worktree failed: task_id no está en el input ni en ctx.taskId (el provider no propagó el contexto del run)'
    }
    try {
      const path = await manager.resetWorktree(taskId)
      // El disco volvió a origin/main — cualquier "lectura previa" que este
      // run tenía registrada ya no describe el contenido actual. Sin este
      // clear, fs_write podría sobrescribir un path dado por leído contra
      // contenido que en realidad nunca vio (el de DESPUÉS del reset).
      if (ctx.readPaths) {
        clearRangeCoverage(ctx.readPaths)
        ctx.readPaths.clear()
      }
      log.info({ taskId, worktree: path }, 'worktree reset')
      return [
        `Worktree reseteado para task ${taskId}.`,
        `Nuevo path: ${path}.`,
        `El tip anterior de task/${taskId} sigue en el reflog (\`git reflog show task/${taskId}\`) por si necesitas rescatarlo; el nuevo HEAD es el tip de origin/main tras el fetch.`,
      ].join(' ')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ taskId, err: msg }, 'reset_worktree failed')
      return `reset_worktree failed: ${msg}`
    }
  },
})
