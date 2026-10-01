/** Un evento crudo del mundo — no sabe nada de negocio, sólo lleva forma. */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  /** Único por evento (un UUID): lo que cita el log de eventos, una ejecución o un replay. */
  id: string
  /** El evento del que se derivó (`deriveEvent`), si alguno: la cadena de causas. */
  parentId?: string
  /** Nombre del evento, ej. "github.issue.opened", "slack.message", "travel.trip.requested". */
  type: string
  payload: TPayload
  /**
   * Filtro opcional para que un Pipeline se restrinja a un subconjunto de eventos del
   * mismo `type` (ej. { workspace: 'acme', channel: 'C123' } o { tripId: 't_1' }).
   * Libre a propósito: a diferencia de engine-v2, acá no asume issueId/projectId/repos —
   * cada dominio (GitHub, Slack, viajes) define sus propias claves de scope.
   */
  scope?: Record<string, unknown>
  occurredAt: string
  /** Profundidad de la cadena de derivación (EmitAction / Agent con emitOn). */
  depth: number
  /** La ejecución adentro de la cual nació (un `EmitAction` de esa corrida), si alguna. El engine
   *  no la hace esperar a esa misma ejecución: sería esperarse a sí misma. */
  executionId?: string
}

export interface CreateEventOptions {
  /** Default: un UUID nuevo. Pasarlo es para un replay (el mismo evento otra vez) o un test. */
  id?: string
  parentId?: string
  scope?: Record<string, unknown>
  depth?: number
  occurredAt?: string
  executionId?: string
}

export function createEvent<TPayload = Record<string, unknown>>(
  type: string,
  payload: TPayload,
  opts: CreateEventOptions = {},
): DomainEvent<TPayload> {
  return {
    id: opts.id ?? globalThis.crypto.randomUUID(),
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    type,
    payload,
    scope: opts.scope,
    occurredAt: opts.occurredAt ?? new Date().toISOString(),
    depth: opts.depth ?? 0,
    ...(opts.executionId ? { executionId: opts.executionId } : {}),
  }
}

/**
 * Evento derivado de otro (EmitAction, Agent con emitOn: 'exit') — hereda profundidad + 1
 * y, salvo que se pase un `scope` explícito, también el `scope` del padre. Sin esto, un
 * Pipeline con `scope: { repo: 'x' }` nunca reacciona a un evento derivado de otro Pipeline
 * sobre ESE mismo repo — encadenar pipelines con scope (el caso de uso central) se rompía en
 * silencio.
 */
export function deriveEvent<TPayload = Record<string, unknown>>(
  parent: DomainEvent,
  type: string,
  payload: TPayload,
  opts: Omit<CreateEventOptions, 'depth' | 'parentId'> = {},
): DomainEvent<TPayload> {
  return createEvent(type, payload, {
    ...opts,
    scope: opts.scope ?? parent.scope,
    depth: parent.depth + 1,
    parentId: parent.id,
    executionId: opts.executionId ?? parent.executionId,
  })
}
