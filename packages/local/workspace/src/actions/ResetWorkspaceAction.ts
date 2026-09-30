import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { z } from 'zod'
import type { WorkspaceSession } from './WorkspaceSession.js'

const Input = z.strictObject({
  reason: z.string().min(1).describe('Por qué descartás lo que hay, en una oración.'),
})

/**
 * `workspace_reset`: el agente descarta su worktree y arranca de nuevo — borra el worktree y la
 * branch LOCAL de la task y los recrea (desde el último push de la branch, o desde la base si
 * nunca se pusheó). Lo local sin pushear se pierde (queda en el reflog del clone). Para cuando el
 * agente dejó el árbol en un estado del que no sabe salir.
 */
export class ResetWorkspaceAction extends Action<typeof Input, string> {
  readonly description =
    'Descarta tu worktree y lo recrea limpio (desde el último push de la branch, o desde la base si nunca se pusheó). Lo que no pusheaste se pierde: usala sólo si el árbol quedó en un estado del que no sabés salir.'
  readonly input = Input
  override readonly workspace = true

  constructor(private readonly session: WorkspaceSession) {
    super({ id: 'workspace_reset' })
  }

  async execute(input: z.infer<typeof Input>, ctx: PipelineExecutionContext): Promise<string> {
    const { target, repoBasePath, branch } = await this.session.prepare(ctx)
    const path = await this.session.manager.resetWorktree(target.task.id, repoBasePath, {
      task: target.task,
      branch,
    })
    return `Worktree recreado en ${path} (branch ${branch}): ${input.reason}`
  }
}
