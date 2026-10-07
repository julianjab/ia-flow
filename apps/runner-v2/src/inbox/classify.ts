/**
 * La regla de la bandeja, pura: con la card del board y lo que el runner sabe de su task (la
 * ejecución viva, la última cerrada, si espera turno), en qué grupo y caso cae, por qué, y qué se
 * puede hacer. Lo que no cae en ninguno (Backlog, Done, una card que nadie tocó) no se muestra.
 *
 * El orden importa: lo que corre gana sobre lo que dice el board (una card en Review cuyo reviewer
 * todavía trabaja está "corriendo", no "para mergear").
 */
import type { BoardCard } from '@ia-flow/github-tools'
import type { ExecutionSummary, InboxGroup, InboxKind, TaskAction } from '@ia-flow/shared'
import type { InboxSettings } from './InboxSection.js'

export type { BoardCard }

/** Lo que el runner sabe de la task de una card. */
export interface TaskActivity {
  /** La ejecución corriendo o pausada. */
  live?: ExecutionSummary
  /** La última que cerró. */
  lastClosed?: ExecutionSummary
  /** Hay una corrida esperando turno. */
  waiting: boolean
  /** El último evento que llegó para la task (ISO). */
  lastEventAt?: string
}

export interface Classification {
  group: InboxGroup
  kind: InboxKind
  why: string
  since: string
  actions: TaskAction[]
}

export interface ClassifyOptions {
  settings: Pick<InboxSettings, 'labels' | 'statuses' | 'staleHours'>
  now: Date
}

const HOUR_MS = 3_600_000

function latest(...dates: Array<string | undefined>): string {
  return (
    dates
      .filter((date): date is string => date !== undefined)
      .sort()
      .at(-1) ?? ''
  )
}

function tokens(execution: ExecutionSummary): string {
  const usage = execution.usage
  if (!usage) return ''
  const total = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens
  return total > 0 ? ` · ${Math.round(total / 1000)}k tokens` : ''
}

function who(execution: ExecutionSummary): string {
  return execution.agent_id
    ? `${execution.pipeline_id} → ${execution.agent_id}`
    : execution.pipeline_id
}

function excerpt(text: string, max = 160): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Lo que corre o espera: gana sobre lo que dice el board. */
function fromActivity(activity: TaskActivity): Classification | undefined {
  const { live } = activity
  if (live?.status === 'running') {
    return {
      group: 'run',
      kind: 'agent',
      why: `${who(live)} corriendo${tokens(live)}`,
      since: live.started_at,
      actions: ['stop'],
    }
  }
  if (live?.status === 'paused') {
    const pauseId = live.pause?.pause_id ?? 'pausa'
    const until = live.pause?.expires_at ? ` · vence ${live.pause.expires_at}` : ''
    const ci = /ci/i.test(pauseId)
    return {
      group: 'run',
      kind: ci ? 'ci' : 'agent',
      why: ci ? `Esperando el CI (${pauseId})${until}` : `Pausada en ${pauseId}${until}`,
      since: live.started_at,
      actions: [],
    }
  }
  if (activity.waiting) {
    return { group: 'queue', kind: 'turn', why: 'Espera su turno', since: '', actions: [] }
  }
  return undefined
}

/** Lo que el pipeline dejó en manos de una persona: Review (mergear, o destrabar un review que
 *  no aprobó) o aprobar el PRD. Una card en Review siempre te necesita, pase lo que pase con ella
 *  — salvo mientras algo corre, que gana antes (`fromActivity`). */
function awaitingHuman(card: BoardCard, { labels, statuses }: ClassifyOptions['settings']) {
  if (card.status === statuses.review) {
    const pr = card.pr ? ` · PR #${card.pr.number}` : ' · sin PR abierto'
    if (card.labels.includes(labels.reviewed)) {
      return {
        group: 'need',
        kind: 'merge',
        why: `Review + ${labels.reviewed}${pr}`,
        since: card.updatedAt,
        actions: card.pr ? ['merge'] : [],
      } satisfies Classification
    }
    // Sin PR no hay nada que revisar: el pipeline de review no correría.
    return {
      group: 'need',
      kind: 'review',
      why: `Review sin ${labels.reviewed}${pr}`,
      since: card.updatedAt,
      actions: card.pr && card.itemId ? ['rerun_review'] : [],
    } satisfies Classification
  }
  if (card.status === statuses.refined) {
    return {
      group: 'need',
      kind: 'prd',
      why: `PRD listo para aprobar (status ${statuses.refined})`,
      since: card.updatedAt,
      actions: ['approve_prd', 'back_to_refine'],
    } satisfies Classification
  }
  return undefined
}

/** Lo que espera otro issue, o lo que se trabó: por una duda del agente o por un error. */
function stuck(
  card: BoardCard,
  activity: TaskActivity,
  { settings }: ClassifyOptions,
): Classification | undefined {
  if (card.blockedBy.length > 0) {
    return {
      group: 'queue',
      kind: 'dep',
      why: `Bloqueada por ${card.blockedBy.join(', ')}`,
      since: card.updatedAt,
      actions: [],
    }
  }
  const { lastClosed } = activity
  const failure = lastClosed?.failure
  const since = lastClosed?.closed_at ?? card.updatedAt
  const blockedLabel = card.labels.includes(settings.labels.blocked)
  // La salida del agente manda sobre el texto de un fallo: `prerequisite` y `doubt` son rutas
  // propias del agente (no un error), y `fail_turn` —que cierra como fallo del agente— sigue
  // siendo una duda para los agentes que todavía no declaran esas salidas.
  if (blockedLabel && lastClosed?.exit === 'prerequisite') {
    return {
      group: 'need',
      kind: 'prerequisite',
      why: `Le falta una pieza: ${excerpt(lastClosed.summary ?? failure?.message ?? '')}`,
      since,
      actions: ['answer_and_unblock'],
    }
  }
  if (blockedLabel && (lastClosed?.exit === 'doubt' || failure?.by === 'agent')) {
    return {
      group: 'need',
      kind: 'doubt',
      why: `El agente tiene una duda: ${excerpt(failure?.message ?? lastClosed?.summary ?? '')}`,
      since,
      actions: ['answer_and_unblock'],
    }
  }
  if (!blockedLabel && lastClosed?.status !== 'failed' && failure?.by !== 'runtime')
    return undefined
  const reason = failure?.message ?? lastClosed?.close_reason
  return {
    group: 'fail',
    kind: 'crash',
    why: reason
      ? `Falló: ${excerpt(reason)}`
      : `Bloqueada (${settings.labels.blocked}) sin una corrida que diga por qué`,
    since,
    actions: ['retry'],
  }
}

/** Refine o Build sin nada que la mueva hace más de `staleHours`. */
function stale(
  card: BoardCard,
  activity: TaskActivity,
  { settings, now }: ClassifyOptions,
): Classification | undefined {
  const { statuses } = settings
  if (card.status !== statuses.refine && card.status !== statuses.build) return undefined
  const last = latest(card.updatedAt, activity.lastEventAt, activity.lastClosed?.closed_at)
  const idleHours = (now.getTime() - Date.parse(last)) / HOUR_MS
  if (idleHours < settings.staleHours) return undefined
  return {
    group: 'need',
    kind: 'stale',
    why: `${card.status} sin movimiento hace ${Math.floor(idleHours)} h`,
    since: last,
    actions: ['relaunch'],
  }
}

export function classify(
  card: BoardCard,
  activity: TaskActivity,
  options: ClassifyOptions,
): Classification | undefined {
  const running = fromActivity(activity)
  if (running) return { ...running, since: running.since || card.updatedAt }
  return (
    awaitingHuman(card, options.settings) ??
    stuck(card, activity, options) ??
    stale(card, activity, options)
  )
}

const GROUP_ORDER: Record<InboxGroup, number> = { need: 0, fail: 1, run: 2, queue: 3, idle: 4 }

/** El orden de lo que no es una decisión (corre, espera turno): por grupo y, dentro de cada uno, lo
 *  más viejo arriba. Las decisiones las ordena `prioritize` por palanca. */
export function inboxOrder(
  a: { group: InboxGroup; since: string },
  b: { group: InboxGroup; since: string },
): number {
  return GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.since.localeCompare(b.since)
}
