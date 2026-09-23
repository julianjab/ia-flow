export interface DomainEventScope {
  projectId?: string
  repos?: string[]
  issueId?: string
  prNumber?: number
}

/** Ej: 'issue.status_changed', 'run.finished', 'pr.merged', 'wait.resumed'.
 *  El catálogo completo vive en @ia-flow/shared/event-catalog en v1.
 *
 *  `scope` es campo propio, no parte de `payload` — es lo que Rule.matches
 *  usa para filtrar por projectId/repoName (matchScope en v1) y lo que Engine
 *  usa para resolver la Task antes de ejecutar. EmitAction lo escribe desde
 *  su propio `scope` al derivar un evento nuevo. */
export class DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly type: string
  readonly payload: TPayload
  readonly scope?: DomainEventScope
  readonly occurredAt: Date
  /** Id del evento que causó éste (deriveEvent en v1) — nulo en un evento raíz. */
  readonly causationId?: string
  /** Profundidad de la cadena de derivación (deriveEvent = padre.depth + 1). */
  readonly depth: number

  constructor(
    type: string,
    payload: TPayload,
    opts: { scope?: DomainEventScope; occurredAt?: Date; causationId?: string; depth?: number } = {},
  ) {
    this.type = type
    this.payload = payload
    this.scope = opts.scope
    this.occurredAt = opts.occurredAt ?? new Date()
    this.causationId = opts.causationId
    this.depth = opts.depth ?? 0
  }
}
