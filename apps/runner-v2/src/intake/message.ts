/**
 * Cómo lee un agente un evento que le llegó mientras corre (sus `injects`): el engine no sabe qué
 * es un comentario o una review, así que el texto lo arma `resolve_task` en `payload.message` y el
 * engine lo toma de ahí (`formatMessage: '{{message}}'` en runner.yaml). Corto y con quién lo dijo
 * — va al lado de su trabajo en curso, no reemplaza el brief.
 */
type Payload = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export function eventMessage(type: string, payload: Payload): string {
  const pr = (payload.pr as { number?: number } | undefined)?.number
  const where = pr ? ` en el PR #${pr}` : ''

  switch (type) {
    case 'issue_comment':
      return `Comentario de @${text(payload.author) || 'alguien'}${where}:\n${text(payload.body)}`
    case 'pull_request_review': {
      const state = text(payload.state).toLowerCase()
      const verdict =
        state === 'changes_requested'
          ? 'pidió cambios'
          : state === 'approved'
            ? 'aprobó'
            : 'comentó'
      const body = text(payload.body)
      return `@${text(payload.reviewer) || 'alguien'} ${verdict}${where}${body ? `:\n${body}` : '.'}`
    }
    case 'check_suite':
    case 'workflow_run':
      return `El CI${where} terminó en ${text(payload.conclusion) || 'un estado desconocido'}.`
    default:
      return `Evento ${type}${where}.`
  }
}
