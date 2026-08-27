import type { SlackMemberRef } from './schemas.js'

// Pedido de review en Slack: a quién se taguea, en qué canal, y con qué texto.
//
// Todo acá es puro y sin I/O — vive en `shared` porque las dos puntas lo
// necesitan: el use-case del server para publicar, y la web para saber si el
// botón "Solicitar review" puede habilitarse (y decir POR QUÉ no, sin tener que
// preguntarle al server).

export interface SlackReviewConfig {
  slackReviewChannel?: string
  slackReviewers?: SlackMemberRef[]
}

export interface SlackReviewTarget {
  channel?: string
  reviewers: SlackMemberRef[]
}

/**
 * Resuelve canal y revisores con fallback **por campo**: un repo puede
 * overridear sólo los revisores y seguir heredando el canal del proyecto, que
 * es el caso normal (un canal de reviews para todo el proyecto, distinta gente
 * por repo).
 *
 * Una lista vacía en el repo **hereda**, no significa "no taguear a nadie": sin
 * revisores el pedido no se habilita, y ese "no hay a quién taguear" es lo que
 * el operador ve en el botón. Un array vacío como forma de apagar el pedido
 * sería indistinguible de un campo que nunca se llenó.
 */
export function resolveSlackReviewTarget(
  repo?: SlackReviewConfig,
  project?: { slackReviewChannel?: string; slackReviewers?: SlackMemberRef[] },
): SlackReviewTarget {
  const channel = firstNonEmpty(repo?.slackReviewChannel, project?.slackReviewChannel)
  const reviewers = repo?.slackReviewers?.length
    ? repo.slackReviewers
    : (project?.slackReviewers ?? [])
  return { ...(channel ? { channel } : {}), reviewers }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const trimmed = v?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/** Por qué el pedido no se puede hacer, en texto para humanos. `undefined` = se puede. */
export function slackReviewBlockedReason(target: SlackReviewTarget): string | undefined {
  if (!target.channel) return 'El repo (o el proyecto) no tiene canal de Slack configurado'
  if (!target.reviewers.length) return 'El repo (o el proyecto) no tiene reviewers configurados'
  return undefined
}

/** `<@id>` separados por espacio. Vale igual para personas y para bots. */
export function renderMentions(reviewers: readonly SlackMemberRef[]): string {
  return reviewers.map((r) => `<@${r.id}>`).join(' ')
}

/**
 * Primer pedido vs. re-review. La distinción no es cosmética: el primero abre
 * el hilo y explica qué se espera de la revisión; el segundo cae DENTRO de ese
 * hilo, donde el revisor ya tiene todo el contexto y sólo necesita saber que
 * hay algo nuevo que mirar.
 */
export type SlackReviewKind = 'first' | 're-review'

export function buildSlackReviewMessage(input: {
  kind: SlackReviewKind
  reviewers: readonly SlackMemberRef[]
  prUrl: string
  prTitle?: string
}): string {
  const mentions = renderMentions(input.reviewers)
  if (input.kind === 're-review') {
    return `${mentions} se realizaron las correcciones porfavor revisar.`
  }
  const title = input.prTitle ? `${input.prTitle}\n` : ''
  return (
    `${mentions} porfavor revisar y aprobar este PR, revisar a detalle que la implementacion ` +
    `no vaya a afectar ningun servicio con un bug o modificando contratos que puedan afectar ` +
    `otros consumidores.\n${title}${input.prUrl}`
  )
}
