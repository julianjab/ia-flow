import type { SlackMemberRef, SlackReviewMessage } from './schemas.js'

// Pedido de review en Slack: a quién se taguea, en qué canal, y con qué texto.
//
// Todo acá es puro y sin I/O — vive en `shared` porque las dos puntas lo
// necesitan: el use-case del server para publicar, y la web para saber si el
// botón "Solicitar review" puede habilitarse (y decir POR QUÉ no, sin tener que
// preguntarle al server), y para previsualizar el texto que se va a mandar.

/**
 * Los campos admiten `null` además de `undefined`: el bag de `project.settings`
 * se mergea por key, así que "limpiar" un campo desde la UI persiste un null en
 * vez de borrar la key. Los dos significan lo mismo acá — heredar.
 */
export interface SlackReviewConfig {
  slackReviewChannel?: string | null
  slackReviewers?: SlackMemberRef[] | null
  slackReviewMessage?: SlackReviewMessage | null
}

export interface SlackReviewTarget {
  channel?: string
  reviewers: SlackMemberRef[]
  /** Plantillas YA resueltas: nunca vacías — sin config son las de abajo. */
  messages: Required<SlackReviewMessage>
}

/**
 * El texto que se manda cuando nadie configuró nada. Es exactamente el que el
 * pipeline venía mandando hardcodeado (typos incluidos): la plantilla se
 * introdujo para poder cambiarlo, no para cambiarlo de prepo.
 *
 * `{{prTitle}}` está en su propia línea a propósito — cuando el PR no expone
 * título, `interpolate` colapsa la línea entera en vez de dejar un salto vacío.
 */
export const DEFAULT_SLACK_REVIEW_MESSAGES: Required<SlackReviewMessage> = {
  first:
    '{{mentions}} porfavor revisar y aprobar este PR, revisar a detalle que la implementacion ' +
    'no vaya a afectar ningun servicio con un bug o modificando contratos que puedan afectar ' +
    'otros consumidores.\n{{prTitle}}\n{{prUrl}}',
  reReview: '{{mentions}} se realizaron las correcciones porfavor revisar.',
}

/** Las variables que una plantilla puede interpolar, para mostrarlas en la UI. */
export const SLACK_REVIEW_TEMPLATE_VARS = ['mentions', 'prUrl', 'prTitle'] as const

/**
 * Resuelve canal, revisores y plantillas con fallback **por campo**: un repo
 * puede overridear sólo los revisores y seguir heredando el canal del proyecto,
 * que es el caso normal (un canal de reviews para todo el proyecto, distinta
 * gente por repo). Lo mismo vale para los dos textos: redefinir el primer
 * pedido no arrastra el del re-review.
 *
 * Una lista vacía en el repo **hereda**, no significa "no taguear a nadie": sin
 * revisores el pedido no se habilita, y ese "no hay a quién taguear" es lo que
 * el operador ve en el botón. Un array vacío como forma de apagar el pedido
 * sería indistinguible de un campo que nunca se llenó. Un texto en blanco sigue
 * el mismo criterio.
 */
export function resolveSlackReviewTarget(
  repo?: SlackReviewConfig,
  project?: SlackReviewConfig,
): SlackReviewTarget {
  const channel = firstNonEmpty(repo?.slackReviewChannel, project?.slackReviewChannel)
  const reviewers = repo?.slackReviewers?.length
    ? repo.slackReviewers
    : (project?.slackReviewers ?? [])
  const messages: Required<SlackReviewMessage> = {
    first:
      firstNonEmpty(repo?.slackReviewMessage?.first, project?.slackReviewMessage?.first) ??
      DEFAULT_SLACK_REVIEW_MESSAGES.first,
    reReview:
      firstNonEmpty(repo?.slackReviewMessage?.reReview, project?.slackReviewMessage?.reReview) ??
      DEFAULT_SLACK_REVIEW_MESSAGES.reReview,
  }
  return { ...(channel ? { channel } : {}), reviewers, messages }
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const v of values) {
    const trimmed = v?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/**
 * Deja sólo los textos que el operador realmente escribió: un campo en blanco
 * se OMITE en vez de guardarse como `''`. Los dos son equivalentes al leer
 * (`resolveSlackReviewTarget` trata el blanco como ausente), pero guardar el
 * string vacío deja al repo marcado como "tiene override" en cada resumen y
 * cada diff de config. `undefined` cuando no quedó nada: es lo que limpia la
 * fila/la key del bag de settings.
 */
export function compactSlackReviewMessage(
  message: SlackReviewMessage | undefined,
): SlackReviewMessage | undefined {
  const first = message?.first?.trim()
  const reReview = message?.reReview?.trim()
  if (!first && !reReview) return undefined
  return { ...(first ? { first } : {}), ...(reReview ? { reReview } : {}) }
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
  /** Plantillas resueltas (`resolveSlackReviewTarget().messages`). Sin esto se
   *  usan las default, que es el texto histórico. */
  messages?: SlackReviewMessage
}): string {
  const template =
    firstNonEmpty(input.kind === 're-review' ? input.messages?.reReview : input.messages?.first) ??
    DEFAULT_SLACK_REVIEW_MESSAGES[input.kind === 're-review' ? 'reReview' : 'first']

  return interpolate(template, {
    mentions: renderMentions(input.reviewers),
    prUrl: input.prUrl,
    prTitle: input.prTitle ?? '',
  })
}

/**
 * Reemplaza `{{var}}` por su valor.
 *
 * Una línea que queda **vacía por culpa de una variable vacía** se borra
 * entera, en vez de dejar un renglón en blanco en el mensaje: el caso concreto
 * es `{{prTitle}}` cuando el PR no expone título. Sólo se colapsan las líneas
 * que TENÍAN un placeholder — un salto de línea que el autor escribió a mano
 * es intencional y se respeta.
 */
function interpolate(template: string, vars: Record<string, string>): string {
  const render = (text: string) =>
    text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => vars[name] ?? match)
  return template
    .split('\n')
    .filter((line) => !/\{\{\s*\w+\s*\}\}/.test(line) || render(line).trim() !== '')
    .map(render)
    .join('\n')
}
