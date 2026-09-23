/** Ej: 'issue.status_changed', 'run.finished', 'pr.merged', 'wait.resumed'.
 *  El catálogo completo vive en @ia-flow/shared/event-catalog en v1. */
export class DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly type: string
  readonly payload: TPayload
  readonly occurredAt: Date

  constructor(type: string, payload: TPayload, occurredAt: Date = new Date()) {
    this.type = type
    this.payload = payload
    this.occurredAt = occurredAt
  }
}
