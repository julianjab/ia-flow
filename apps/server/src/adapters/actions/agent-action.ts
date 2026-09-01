import type { DispatchOutcome, IIssueManager, IssueItem } from '@ia-flow/issue-sources'
import {
  type ActionContext,
  type ActionHandler,
  type ActionResult,
  renderBrief,
} from '@ia-flow/rules'
import { AgentActionSchema, type EngineEvent, RUN_FINISHED } from '@ia-flow/shared'
import type { z } from 'zod'
import { createLogger } from '../../logger.js'

const log = createLogger('action:agent')

type AgentConfig = z.infer<typeof AgentActionSchema>

export interface AgentActionDeps {
  /** El manager del proyecto del evento, o `undefined` si no hay uno vivo
   *  (proyecto archivado, o el daemon todavía no lo levantó). */
  managerFor(projectId: string): IIssueManager | undefined
  /**
   * Corre el agente y devuelve, además del outcome, **lo que produjo**.
   *
   * El output vuelve por acá y no por el `DispatchOutcome` porque aquél es el
   * vocabulario del dispatcher —soltar el item o devolverlo al backlog— y a un
   * `SourceDispatcher` no le sirve de nada un texto. Acá el consumidor es una
   * regla, que puede pasárselo al paso siguiente.
   */
  dispatch(
    item: IssueItem,
    manager: IIssueManager,
    agentId: string,
    ruleId: string,
    event: { id: string; type: string; position: number },
    /** El `brief` de la acción, ya rendido contra el evento. */
    brief?: string,
    /** Redirecciones de salida que la regla declaró para este disparo. */
    exits?: AgentConfig['exits'],
  ): Promise<{ outcome: DispatchOutcome; output?: unknown }>
  /**
   * Resuelve el issue sobre el que correr, cuando el evento no lo trae.
   *
   * Sólo los eventos de la fuente (`issue.*`) llevan el item en el payload:
   * los de GitHub —`pr.opened`, `pr.review_submitted`, `ci.finished`— traen el
   * PR y el scope, porque el webhook habla de un PR y no sabe de qué issue del
   * board cuelga. Sin esto, una regla sobre cualquiera de ellos con
   * `action: agent` no dispara nada y contesta "el evento no trae un issue" —
   * o sea que la mitad del catálogo de eventos es inservible para el uso más
   * obvio que tiene.
   *
   * Opcional: sin implementar, el comportamiento es el de antes (sólo corren
   * los eventos que traen item).
   */
  resolveItem?(projectId: string, scope: EngineEvent['scope']): Promise<IssueItem | undefined>
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

    // El item viene en el payload cuando el evento lo produjo el scan de la
    // fuente. Si no, hay que ir a buscarlo — un `pr.review_submitted` sabe de
    // qué PR habla, no de qué issue.
    let item = ctx.event.payload.item as IssueItem | undefined
    if (!item && this.deps.resolveItem) {
      try {
        item = await this.deps.resolveItem(projectId, ctx.event.scope)
      } catch (err) {
        // Diferido y no fallado, por lo mismo que el manager ausente: la
        // fuente puede estar caída un momento, y correr el `onError` del
        // agente comentaría un fallo de un run que nunca se intentó.
        log.warn(
          { projectId, ruleId: ctx.rule.id, err: (err as Error).message },
          'resolveItem falló — difiriendo',
        )
        return { ok: false, deferred: true, detail: 'no se pudo resolver el issue del evento' }
      }
    }
    if (!item) {
      // `skipped` y no un fallo: un `pr.opened`/`ci.finished` de un PR que
      // ningún issue del board linkea es un caso normal —alguien abrió un PR a
      // mano—, y desde que `resolveItem` existe deja de ser raro. Marcarlo como
      // error abortaría las acciones siguientes del `do[]` y pintaría la regla
      // de rojo por algo que funcionó como tiene que funcionar.
      return {
        ok: false,
        skipped: true,
        detail: 'el evento no apunta a ningún issue de este proyecto',
      }
    }

    const manager = this.deps.managerFor(projectId)
    if (!manager) {
      // Diferido y no fallado: el manager puede aparecer (un reload en curso,
      // un proyecto que se está levantando), y fallar acá haría que el
      // `onError` del agente comente un fallo que nunca se intentó.
      log.warn({ projectId, ruleId: ctx.rule.id }, 'No manager for project — deferring')
      return { ok: false, deferred: true, detail: `sin manager para ${projectId}` }
    }

    // El brief se rinde ACÁ, que es el único punto que tiene el evento a mano.
    // Lo que baja al dispatcher es texto ya resuelto: ni el dispatcher ni el
    // orquestador ni `Agent` aprenden nada sobre eventos para poder usarlo.
    const brief = config.brief?.trim() ? renderBrief(config.brief, ctx.event) : undefined

    const { outcome, output } = await this.deps.dispatch(
      item,
      manager,
      config.agentId,
      ctx.rule.id,
      {
        id: ctx.event.id,
        type: ctx.event.type,
        // La posición de ESTA acción en el `do[]`: sin ella la fila del run
        // empataría en 0 con la primera acción y el orden del grupo en la UI
        // quedaría a merced del sort del listado.
        position: ctx.position,
      },
      brief,
      config.exits,
    )
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

    // El `skipped` del dispatcher es el MISMO hecho que el del item sin
    // resolver: el item no aplicaba (bloqueado, sin projectId, la regla nombró
    // un agente que este proyecto no tiene, `validate` lo rechazó). Todos son
    // normales, y sin marcarlos como tales el runner corta el `do[]` y la fila
    // queda en rojo — que es justo lo que `ActionResult.skipped` existe para
    // evitar. Traducirlo en una sola rama era resolver medio problema.
    if (outcome === 'skipped') return { ok: false, skipped: true, detail: outcome }

    // Lo que este agente deja para el paso siguiente: el objeto que entregó por
    // `submit_output` si declaró un contrato de salida, o su texto final si no.
    // Las dos formas conviven a propósito — un agente sin contrato sigue siendo
    // encadenable por texto, así que adoptar `output` es agente por agente y no
    // una migración del roster entero.
    return { ok: outcome === 'dispatched', detail: outcome, output }
  }
}
