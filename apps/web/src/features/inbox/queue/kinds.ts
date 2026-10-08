// Cómo se ve cada TIPO de decisión (no cada grupo): glifo, tono, verbo y el botón de su acción.
// Puro, sin Vue.

import type { InboxItem, TaskActionDef } from '@ia-flow/shared'
import { KIND_LABEL, primaryAction } from '@/features/inbox/labels'
import { shortRef } from '@/features/inbox/queue/shortRef'

/** El tipo de una decisión: lo que filtra y lo que da el color. */
export type QueueType = 'merge' | 'prd' | 'review' | 'answer' | 'relaunch' | 'fail' | 'other'

/** El token de color de theme.css (`var(--<tone>)`). */
export type QueueTone = 'accent' | 'info' | 'warn' | 'danger' | 'fg-mute'

export interface TypeMeta {
  glyph: string
  tone: QueueTone
  /** Cómo se llama en el filtro. */
  label: string
}

export const TYPE_META: Record<QueueType, TypeMeta> = {
  merge: { glyph: '✓', tone: 'accent', label: 'Mergear' },
  prd: { glyph: '○', tone: 'info', label: 'Aprobar PRD' },
  review: { glyph: '↻', tone: 'accent', label: 'Re-review' },
  answer: { glyph: '⛔', tone: 'warn', label: 'Responder' },
  relaunch: { glyph: '◐', tone: 'warn', label: 'Relanzar' },
  fail: { glyph: '✕', tone: 'danger', label: 'Reintentar' },
  other: { glyph: '→', tone: 'fg-mute', label: 'Otras' },
}

/** El orden de los chips del filtro. */
export const TYPE_ORDER: readonly QueueType[] = [
  'merge',
  'prd',
  'review',
  'answer',
  'relaunch',
  'fail',
  'other',
]

export function typeOf(item: Pick<InboxItem, 'kind' | 'group'>): QueueType {
  switch (item.kind) {
    case 'merge':
      return 'merge'
    case 'prd':
      return 'prd'
    case 'review':
      return 'review'
    case 'doubt':
    case 'prerequisite':
      return 'answer'
    case 'stale':
      return 'relaunch'
    case 'crash':
      return 'fail'
    default:
      return item.group === 'fail' ? 'fail' : 'other'
  }
}

/** El verbo de la decisión: el del dashboard o uno por caso. */
export function verbOf(item: InboxItem): string {
  if (item.verb) return item.verb
  const agent = item.execution?.agent_id
  switch (item.kind) {
    case 'merge':
      return item.pr ? `Mergear el PR #${item.pr.number}` : 'Mergear el PR'
    case 'prd':
      return 'Aprobar el PRD'
    case 'review':
      return 'Pedir otra review'
    case 'doubt':
      return agent ? `Responder al ${agent}` : 'Responder al agente'
    case 'prerequisite':
      return agent ? `Darle un dato al ${agent}` : 'Destrabar'
    case 'stale':
      return agent ? `Relanzar el ${agent}` : 'Relanzar'
    case 'crash':
      return agent ? `Reintentar el ${agent}` : 'Reintentar'
    default:
      return KIND_LABEL[item.kind]
  }
}

/** Un botón de acción tal como lo dibuja la card. */
export interface QueueAction {
  id: string
  /** Con «…» si pide confirmación. */
  label: string
  confirms: boolean
  /** Pide un texto (Responder). */
  comment?: 'required' | 'optional'
}

const SHORT_LABEL: Record<string, string> = {
  merge: 'Mergear',
  approve_prd: 'Aprobar',
  rerun_review: 'Re-review',
  answer_and_unblock: 'Responder',
  relaunch: 'Relanzar',
  retry: 'Reintentar',
  stop: 'Detener',
  back_to_refine: 'Devolver a Refine',
}

/** Las que firman con GitHub o no se deshacen. Relanzar y Responder no confirman. */
const CONFIRMS = new Set(['merge', 'approve_prd', 'stop'])

export function actionOf(id: string, defs: readonly TaskActionDef[] = []): QueueAction {
  const def = defs.find((d) => d.id === id)
  const base = def?.label ?? SHORT_LABEL[id] ?? id
  const confirms = CONFIRMS.has(id) || Boolean(def?.confirm)
  const comment = def?.comment ?? (id === 'answer_and_unblock' ? 'required' : undefined)
  return {
    id,
    label: confirms ? `${base}…` : base,
    confirms,
    ...(comment ? { comment } : {}),
  }
}

/** La acción principal: la del dashboard, la del caso o la primera ofrecida (si la ofrece). */
export function primaryOf(item: InboxItem): string | undefined {
  const offered = item.actions
  if (item.primary && offered.includes(item.primary)) return item.primary
  const byKind = primaryAction(item.kind)
  if (byKind && offered.includes(byKind)) return byKind
  return offered.find((id) => id !== 'stop') ?? offered[0]
}

/** «a», «a y b», «a, b y c». */
export function listOf(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`
}

export interface ConfirmCopy {
  /** Qué se firma, dónde y con quién. */
  text: string
  /** El botón que ejecuta: «Mergear ahora», «Aprobar los 2 ahora». */
  label: string
}

const who = (login?: string) => `tu usuario de GitHub${login ? ` (@${login})` : ''}`

/**
 * La confirmación en línea de una acción sobre una o varias tareas (un grupo). Lo que traiga el
 * proyecto (`confirm`) manda sobre el texto genérico.
 */
export function confirmCopy(
  action: QueueAction,
  targets: ReadonlyArray<Pick<InboxItem, 'ref' | 'pr' | 'action_defs'>>,
  login?: string,
): ConfirmCopy {
  const many = targets.length > 1
  const n = targets.length
  const refs = listOf(targets.map((t) => shortRef(t.ref)))
  const custom = targets[0]?.action_defs?.find((d) => d.id === action.id)?.confirm
  const base = action.label.replace(/…$/, '')
  if (custom && !many) return { text: custom, label: `${base} ahora` }
  switch (action.id) {
    case 'merge': {
      const one = targets[0]
      const where = one?.pr ? `el PR #${one.pr.number} de ${refs}` : `el PR de ${refs}`
      return many
        ? {
            text: `Se mergean los PRs de ${refs} con ${who(login)}.`,
            label: `Mergear los ${n} ahora`,
          }
        : { text: `Se mergea ${where} con ${who(login)}.`, label: 'Mergear ahora' }
    }
    case 'approve_prd':
      return many
        ? {
            text: `Se aprueban los PRDs de ${refs} con ${who(login)}: pasan a Build.`,
            label: `Aprobar los ${n} ahora`,
          }
        : {
            text: `Se aprueba el PRD de ${refs} con ${who(login)}: pasa a Build.`,
            label: 'Aprobar ahora',
          }
    case 'stop':
      return {
        text: `Se detiene la ejecución en curso de ${refs} con ${who(login)}: no se retoma sola.`,
        label: 'Detener ahora',
      }
    default:
      return { text: `Se ejecuta «${base}» en ${refs} con ${who(login)}.`, label: `${base} ahora` }
  }
}
