import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { z } from 'zod'
import type { WorkspaceSession } from './WorkspaceSession.js'

const NoInput = z.strictObject({})

/**
 * Paso de pipeline que suelta el worktree de la corrida cuando ya no hace falta — el
 * `cleanupTerminalWorktree` del manager, con todos sus guards: sólo borra si no hay trabajo sin
 * commitear ni sin pushear, y borra la branch remota sólo si no aporta nada sobre la base.
 *
 * Opcional: se agrega al final del `do` de una pipeline (`do: [agente, cleanupWorkspace]`) donde
 * convenga liberar disco; sin él, el worktree queda y la corrida siguiente de la task lo reusa.
 * Si en la corrida ninguna tool de disco pidió workspace, no hace nada.
 */
export class CleanupWorkspaceAction extends Action<typeof NoInput, string> {
  readonly description = 'Suelta el worktree de la corrida si no tiene trabajo en riesgo.'
  readonly input = NoInput

  constructor(private readonly session: WorkspaceSession) {
    super({ id: 'cleanup_workspace' })
  }

  async execute(_input: z.infer<typeof NoInput>, ctx: PipelineExecutionContext): Promise<string> {
    const pending = this.session.prepared(ctx)
    if (!pending) return 'Sin workspace en esta corrida: nada que limpiar.'
    const { target, repoBasePath, branch, path } = await pending
    await this.session.manager.cleanupTerminalWorktree(target.task, repoBasePath, branch, path)
    return `Limpieza de ${path} evaluada (se borra sólo si no tenía trabajo en riesgo).`
  }
}
