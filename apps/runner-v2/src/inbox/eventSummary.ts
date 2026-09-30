/**
 * El resumen legible de un evento para `event_log`: lo mínimo para entender qué llegó sin guardar
 * el payload crudo de GitHub (acción, campo, de→a, label, PR, autor, un extracto del comentario).
 * Sirve para los webhooks crudos (`github.*`) y para los eventos de dominio que arma el intake.
 */
import type { DomainEvent } from '@ia-flow/agent-engine'

type Summary = Record<string, string | number | boolean>
type Raw = Record<string, unknown>

const obj = (value: unknown): Raw | undefined =>
  typeof value === 'object' && value !== null ? (value as Raw) : undefined

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

function excerpt(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** El primero que trae algo. */
const first = <T>(...values: Array<T | undefined>): T | undefined =>
  values.find((value) => value !== undefined)

/** Los objetos del payload crudo de GitHub donde vive cada dato. */
function sections(payload: Raw) {
  const fieldValue = obj(obj(payload.changes)?.field_value)
  return {
    fieldValue,
    comment: obj(payload.comment),
    pr: obj(payload.pull_request),
    review: obj(payload.review),
    check: first(obj(payload.check_suite), obj(payload.workflow_run)),
  }
}

export function summarizeEvent(event: DomainEvent<any>, commentExcerpt: number): Summary {
  const payload = obj(event.payload) ?? {}
  const { fieldValue, comment, pr, review, check } = sections(payload)
  const body = first(str(payload.body), str(comment?.body), str(review?.body))
  const sender = obj(payload.sender)

  const entries: Array<[string, string | number | boolean | undefined]> = [
    ['action', str(payload.action)],
    ['field', first(str(payload.fieldName), str(fieldValue?.field_name))],
    ['from', first(str(payload.from), str(obj(fieldValue?.from)?.name))],
    ['to', first(str(payload.to), str(obj(fieldValue?.to)?.name))],
    ['label', str(obj(payload.label)?.name)],
    ['pr', first(num(payload.prNumber), num(pr?.number), num(obj(payload.pr)?.number))],
    ['state', first(str(payload.state), str(review?.state))],
    ['conclusion', first(str(payload.conclusion), str(check?.conclusion))],
    ['check', first(str(payload.name), str(check?.name))],
    ['author', first(str(payload.author), str(sender?.login), str(payload.sender))],
    ['issue', str(event.scope?.issue)],
    ['comment', body && commentExcerpt > 0 ? excerpt(body, commentExcerpt) : undefined],
  ]
  const summary: Summary = {}
  for (const [key, value] of entries) if (value !== undefined) summary[key] = value
  return summary
}
