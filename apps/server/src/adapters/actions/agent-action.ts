import type { DispatchOutcome, IIssueManager, IssueItem } from '@ia-flow/issue-sources'
import type { ActionContext, ActionHandler, ActionResult } from '@ia-flow/rules'
import { AgentActionSchema, RUN_FINISHED } from '@ia-flow/shared'
import type { z } from 'zod'
import { createLogger } from '../../logger.js'

const log = createLogger('action:agent')

type AgentConfig = z.infer<typeof AgentActionSchema>

export interface AgentActionDeps {
  /** El manager del proyecto del evento, o `undefined` si no hay uno vivo
   *  (proyecto archivado, o el daemon todavía no lo levantó). */
  managerFor(projectId: string): IIssueManager | undefined
  dispatch(
    item: IssueItem,
    manager: IIssueManager,
    agentId: string,
    ruleId: string,
    event: { id: string; type: string; position: number },
  ): Promise<DispatchOutcome>
}

/**
 * Correr un agente.
 *
 * Envuelve `AgentOrchestrator.runAgent` tal cual, así que el agente conserva
 * intactos su prompt, tools, MCP, policy y workspace. Lo único que cambia es
 * quién decide cuándo corre: antes su propia activación, ahora una regla.
 *
 * `deferred` se propaga hacia arriba en vez de tratarse como falla: significa
 * "hay trabajo pero no capacidad", y perderlo dejaría el item sin reintento
 * hasta el próximo scan de la fuente.
 */
export class AgentAction implements ActionHandler<AgentConfig> {
  readonly kind = 'agent'
  readonly configSchema = AgentActionSchema

  constructor(private readonly deps: AgentActionDeps) {}

  async execute(ctx: ActionContext, config: AgentConfig): Promise<ActionResult> {
    const projectId = ctx.event.scope.projectId
    if (!projectId) {
      // Un evento sin scope no puede correr un agente: no hay proyecto del
      // que sacar config, repos ni credenciales. Es el caso de un mensaje
      // crudo de Slack, y la respuesta correcta es que una regla global lo
      // pase antes por un paso de triage que le asigne scope.
      return { ok: false, detail: 'evento sin projectId — el agente necesita un proyecto' }
    }

    const item = ctx.event.payload.item as IssueItem | undefined
    if (!item) {
      return { ok: false, detail: 'el evento no trae un issue sobre el que correr' }
    }

    const manager = this.deps.managerFor(projectId)
    if (!manager) {
      // Diferido y no fallado: el manager puede aparecer (un reload en curso,
      // un proyecto que se está levantando), y fallar acá haría que el
      // `onError` del agente comente un fallo que nunca se intentó.
      log.warn({ projectId, ruleId: ctx.rule.id }, 'No manager for project — deferring')
      return { ok: false, deferred: true, detail: `sin manager para ${projectId}` }
    }

    const outcome = await this.deps.dispatch(item, manager, config.agentId, ctx.rule.id, {
      id: ctx.event.id,
      type: ctx.event.type,
      // La posición de ESTA acción en el `do[]`: sin ella la fila del run
      // empataría en 0 con la primera acción y el orden del grupo en la UI
      // quedaría a merced del sort del listado.
      position: ctx.position,
    })
    if (outcome === 'deferred') return { ok: false, deferred: true, detail: 'sin capacidad' }

    // `emitOn: 'exit'` convierte al agente en un NORMALIZADOR: su salida entra
    // al bus como un evento derivado, que es lo que permite que un triager
    // tome un mensaje sin scope y produzca uno ya ruteable.
    //
    // Se emite sólo si el run arrancó: publicar el "resultado" de un dispatch
    // que nunca corrió le daría a la regla siguiente un evento que no
    // representa nada.
    if (config.emitOn === 'exit' && outcome === 'dispatched') {
      await ctx.emit(config.emitType ?? RUN_FINISHED, {
        agentId: config.agentId,
        taskId: item.id,
        outcome,
      })
    }

    return { ok: outcome === 'dispatched', detail: outcome }
  }
}
