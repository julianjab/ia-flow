export interface DomainEventScope {
  projectId?: string
  repos?: string[]
  issueId?: string
  prNumber?: number
}

/** `type` es un string libre — el shape de `payload` para cada `type`
 *  conocido vive en `EventCatalog` (./EventCatalog.ts), no acá: esta clase
 *  no conoce integraciones ni event types concretos a propósito.
 *
 *  `scope` es campo propio, no parte de `payload` — es lo que Rule.matches
 *  usa para filtrar por projectId/repoName (matchScope en v1) y lo que Engine
 *  usa para resolver la Task antes de ejecutar. EmitAction lo escribe desde
 *  su propio `scope` al derivar un evento nuevo. */
export class DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  /** Único por evento — es lo que un evento derivado usa como su `causationId`.
   *  Dos eventos del mismo `type` en el mismo milisegundo deben poder
   *  distinguirse, así que NO sale de type+occurredAt. */
  readonly id: string
  readonly type: string
  readonly payload: TPayload
  readonly scope?: DomainEventScope
  readonly occurredAt: Date
  /** Id del evento que causó éste (deriveEvent en v1) — nulo en un evento raíz. */
  readonly causationId?: string
  /** Profundidad de la cadena de derivación (deriveEvent = padre.depth + 1).
   *  Engine.dispatch la corta contra MAX_EVENT_DEPTH (ver engine/Engine.ts)
   *  — sin este freno, una regla que se re-emite a sí misma (directo, o vía
   *  un ciclo de N reglas) no tiene fondo. */
  readonly depth: number

  constructor(
    type: string,
    payload: TPayload,
    opts: {
      id?: string
      scope?: DomainEventScope
      occurredAt?: Date
      causationId?: string
      depth?: number
    } = {},
  ) {
    this.id = opts.id ?? crypto.randomUUID()
    this.type = type
    this.payload = payload
    this.scope = opts.scope
    this.occurredAt = opts.occurredAt ?? new Date()
    this.causationId = opts.causationId
    this.depth = opts.depth ?? 0
  }

  /** El evento que este DomainEvent produce como hijo — causationId = this.id,
   *  depth = this.depth + 1. Es lo que EmitAction y AgentAction (emitOn: 'exit')
   *  usan para derivar, así que la relación padre→hijo vive en un solo lugar. */
  derive<TChildPayload extends Record<string, unknown>>(
    type: string,
    payload: TChildPayload,
    scope?: DomainEventScope,
  ): DomainEvent<TChildPayload> {
    return new DomainEvent(type, payload, {
      scope: scope ?? this.scope,
      causationId: this.id,
      depth: this.depth + 1,
    })
  }
}
