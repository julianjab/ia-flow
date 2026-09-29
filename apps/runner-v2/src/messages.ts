/**
 * Cómo lee un agente un evento que le llegó mientras corre (sus `injects`): el engine no
 * sabe qué es un comentario o una review, así que el texto lo arma la app. Corto y con quién lo
 * dijo — va al lado de su trabajo en curso, no reemplaza el brief.
 */
import type { DomainEvent } from '@ia-tools/agent-engine'

type Payload = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export function formatEventMessage(event: DomainEvent<any>): string {
  const payload = (event.payload ?? {}) as Payload
  const pr = (payload.pr as { number?: number } | undefined)?.number
  const where = pr ? ` en el PR #${pr}` : ''

  switch (event.type) {
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
      return `Evento ${event.type}${where}.`
  }
}
