/**
 * Qué deja el despacho en la traza — lo usan los decorators de `Engine`, `DispatchPlanner`,
 * `ExecutionCoordinator` y `Redelivery`, así el despacho no mezcla spans con la lógica.
 */
import {
  SpanKind,
  type SpanLink,
  scopeAttributes,
  type TagOptions,
  type TraceOptions,
} from '@ia-flow/telemetry'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { Candidate, DispatchPlan, DispatchPlanner } from './DispatchPlanner.js'
import type { Engine } from './Engine.js'
import type { Execution } from './Execution.js'
import type { ExecutionCoordinator, Offer, Resolution } from './ExecutionCoordinator.js'
import type { Redelivery } from './Redelivery.js'
import type { DispatchOutcome } from './RunLauncher.js'

/** Instrumentation scope de los spans de este paquete. */
export const SCOPE = '@ia-flow/agent-engine'

/**
 * `event <type>`: la raíz de la traza de TODO lo que el evento causa (o un hijo, si lo publicó un
 * paso de otra pipeline). Su scope queda heredado como atributos `ia.<clave>` en cada span y log
 * de abajo.
 */
export const dispatchTrace: TraceOptions<Engine, [DomainEvent<any>], DispatchOutcome> = {
  name: (event) => `event ${event.type}`,
  kind: SpanKind.CONSUMER,
  scope: SCOPE,
  inherit: (event) => ({
    ...scopeAttributes(event.scope),
    'ia.event.type': event.type,
    'ia.event.depth': event.depth,
  }),
  attributes: (event) => ({ 'ia.event.occurred_at': event.occurredAt }),
  onResult(span, outcome, event) {
    span.setAttribute('ia.dispatch.outcome', outcome)
    if (event.depth >= this.maxEventDepth) {
      this.log.warn(
        `evento "${event.type}" descartado: profundidad ${event.depth} ≥ ${this.maxEventDepth}`,
      )
    }
  },
}

/**
 * Qué corre y por qué no corre el resto: un span event `pipeline.match` por cada pipeline que
 * escucha este tipo de evento (las que escuchan otros tipos serían ruido), y un log con el
 * resumen. Es lo primero que se mira cuando "no pasó nada".
 */
export const planTag: TagOptions<DispatchPlanner, [DomainEvent<any>], DispatchPlan> = {
  onResult(span, plan, event) {
    const skipped: string[] = []
    const running = new Set(plan.toRun.map(({ pipeline }) => pipeline))
    for (const { pipeline, mismatch } of plan.candidates) {
      if (!pipeline.on.includes(event.type)) continue
      const runs = running.has(pipeline)
      const reason = runs
        ? undefined
        : (mismatch ?? `la tapa la exclusive "${plan.winningExclusive?.id}"`)
      if (reason) skipped.push(`${pipeline.id} (${reason})`)
      span.addEvent('pipeline.match', {
        'ia.pipeline.id': pipeline.id,
        'ia.pipeline.runs': runs,
        ...(reason ? { 'ia.pipeline.skip_reason': reason } : {}),
      })
    }
    const ran = [...running].map((pipeline) => pipeline.id)
    span.setAttribute('ia.pipelines.run', ran)
    this.log[ran.length > 0 ? 'info' : 'warn'](
      ran.length > 0
        ? `evento "${event.type}": corren ${ran.join(', ')}`
        : `evento "${event.type}": ninguna pipeline corre`,
      { 'ia.pipelines.skipped': skipped },
    )
  },
}

/**
 * Qué pasó al ofrecerle el evento a la ejecución de su task: `execution.inject` si lo recibió su
 * paso activo (el agente deja `inbox.delivered` cuando lo lee), `execution.resume` si despertó su
 * pausa. Un span event en el despacho y un log.
 */
export const offerTag: TagOptions<ExecutionCoordinator, [DomainEvent<any>], Offer | undefined> = {
  onResult(span, offer, event) {
    if (!offer) return
    if (offer.kind === 'injected') {
      const { executionId, stepId } = offer
      span.addEvent('execution.inject', {
        'ia.execution.id': executionId,
        ...(stepId ? { 'ia.agent.id': stepId } : {}),
      })
      this.log.info(
        `evento "${event.type}" inyectado a ${stepId ?? 'la ejecución'} (${executionId})`,
        { 'ia.execution.id': executionId },
      )
      return
    }
    span.addEvent('execution.resume', {
      'ia.execution.id': offer.executionId,
      'ia.pause.branch': offer.branch,
    })
    this.log.info(`evento "${event.type}" reanuda ${offer.executionId} por "${offer.branch}"`, {
      'ia.execution.id': offer.executionId,
    })
  },
}

/** `execution.expired`: una pausa que venció y se reanuda por su rama `timeout` — traza propia. */
export const expireTrace: TraceOptions<ExecutionCoordinator, [Execution], DispatchOutcome> = {
  name: 'execution.expired',
  kind: SpanKind.INTERNAL,
  scope: SCOPE,
  inherit: (execution) => ({ 'ia.execution.id': execution.id }),
  onResult(span, outcome, execution) {
    span.setAttribute('ia.dispatch.outcome', outcome)
    this.log.info(`${execution.id}: su pausa venció`, { 'ia.execution.id': execution.id })
  },
}

/**
 * Qué pasó con cada pipeline frente a la ejecución de su task — lo que `pipeline.match` no puede
 * decir (se registra al planear, antes de mirar las ejecuciones): un span event
 * `pipeline.if_running` con la decisión (`Resolution`) y la ejecución con la que chocó, más un
 * log cuando no arranca de una. Las que no pasan por ejecuciones no dejan nada.
 */
export const ifRunningTag: TagOptions<
  ExecutionCoordinator,
  [Candidate, DomainEvent<any>],
  Resolution
> = {
  onResult(span, resolution, { pipeline }, event) {
    const { decision, executionId, agentId, detach } = resolution
    if (decision === 'direct') return
    span.addEvent('pipeline.if_running', {
      'ia.pipeline.id': pipeline.id,
      'ia.pipeline.if_running': decision,
      ...(executionId ? { 'ia.execution.id': executionId } : {}),
      ...(agentId ? { 'ia.agent.id': agentId } : {}),
      ...(detach ? { 'ia.execution.detached': true } : {}),
    })
    const on = executionId ? ` (${executionId})` : ''
    const attributes = {
      'ia.pipeline.id': pipeline.id,
      ...(executionId ? { 'ia.execution.id': executionId } : {}),
    }
    if (decision === 'skipped') {
      this.log.info(
        `evento "${event.type}" descartado para ${pipeline.id}: la task está ocupada${on}`,
        attributes,
      )
    } else if (decision === 'waits') {
      this.log.info(
        `evento "${event.type}" espera para ${pipeline.id}: la task está ocupada${on}`,
        attributes,
      )
    } else if (decision === 'interrupts') {
      this.log.info(
        `evento "${event.type}" interrumpe al agente de la task${on}: ${pipeline.id} corre cuando ceda`,
        attributes,
      )
    }
  },
}

/**
 * `event <type>` de un evento inyectado que nadie leyó y se vuelve a despachar al cerrar la
 * ejecución: una traza NUEVA (corre en `inFreshContext`), enlazada al despacho que lo inyectó.
 */
export const redeliverTrace: TraceOptions<
  Redelivery,
  [DomainEvent<any>, string, SpanLink | undefined],
  DispatchOutcome
> = {
  name: (event) => `event ${event.type}`,
  kind: SpanKind.CONSUMER,
  scope: SCOPE,
  inherit: dispatchTrace.inherit as TraceOptions<
    Redelivery,
    [DomainEvent<any>, string, SpanLink | undefined],
    DispatchOutcome
  >['inherit'],
  attributes: (event, executionId) => ({
    'ia.event.occurred_at': event.occurredAt,
    'ia.dispatch.redelivered_from': executionId,
  }),
  links: (_event, _executionId, origin) => (origin ? [origin] : []),
  onResult(span, outcome) {
    span.setAttribute('ia.dispatch.outcome', outcome)
  },
}
