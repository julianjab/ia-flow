import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { z } from 'zod'
import { describePublish } from '../publish.js'
import type { WorkspaceSession } from './WorkspaceSession.js'

const NoInput = z.strictObject({})

/**
 * Paso de pipeline que publica en `origin/<branch>` los commits que el agente dejó en el worktree
 * de la corrida y no pudo pushear (el MCP de GitHub sin auth, el shell sin credenciales): con la
 * credencial del runner, sin force y nunca a una branch protegida. Va antes de
 * `ensure_pull_request`, para que el PR se abra con el código, y en las salidas de error, para que
 * el trabajo no quede sólo en disco.
 *
 * Si la corrida fue en un host remoto, el worktree no está acá: el host ya publicó al cerrar la
 * corrida. Sin workspace, no hace nada. Nunca falla la ruta: lo que no pudo, lo dice.
 */
export class PublishBranchAction extends Action<typeof NoInput, string> {
  readonly description = 'Publica los commits locales del worktree de la corrida en su branch.'
  readonly input = NoInput

  constructor(private readonly session: WorkspaceSession) {
    super({ id: 'publish_branch' })
  }

  async execute(_input: z.infer<typeof NoInput>, ctx: PipelineExecutionContext): Promise<string> {
    const pending = this.session.prepared(ctx)
    if (!pending) {
      return 'Sin worktree de esta corrida en el runner (no tocó disco, o corrió en un host, que publica al cerrar).'
    }
    const { path, branch } = await pending
    return describePublish(branch, await this.session.manager.publishBranch(path, branch))
  }
}
