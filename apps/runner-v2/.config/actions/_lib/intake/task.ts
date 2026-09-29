/**
 * Lo que `resolve_task` hace con lo que leyó de GitHub — puro, sin I/O:
 *
 *   linkedIssue   el issue que implementa un PR: su rama `<prefijo><n>` o un `Closes #n`
 *   boardItem     la card de un board entre los items de un issue (status y tipo)
 *   issueRefs     los issues abiertos de una lista de GitHub, de los repos del proyecto
 *   openPr        el PR abierto de la task: el del evento, o el de su rama
 *   taskPayload   el evento de la task, con la forma que filtran las pipelines y leen los prompts
 */
import { assemblePayload, type EventArgs } from './payload.js'
import {
  type RawComment,
  type RawReview,
  type RawThread,
  rollupCi,
  taskTimeline,
} from './timeline.js'

type Input = Record<string, unknown>

const same = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** El issue de un PR: la rama `<prefix><n>` que abre el implementer, o una referencia de cierre
 *  (`Closes #n`) en el body; si no, `fallback`. */
export function linkedIssue(
  head: string | undefined,
  body: string | undefined,
  prefix: string,
): number | undefined {
  if (head?.startsWith(prefix)) {
    const n = head.slice(prefix.length)
    if (/^\d+$/.test(n)) return Number(n)
  }
  const closing = (body ?? '').match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i)
  return closing?.[1] ? Number(closing[1]) : undefined
}

/** Un `ProjectV2Item` por GraphQL: su board y los valores de sus campos single-select. */
export interface RawItem {
  id: string
  project?: { number: number; owner?: { login?: string } }
  fieldValues?: { nodes?: Array<{ name?: string; field?: { name?: string } } | null> }
}

/** Lo que las pipelines filtran de la card: `item.status` e `item.type`. */
export interface Card {
  itemId: string
  status?: string
  /** `functional` | `technical` — el campo `Task Type` en minúsculas; sin él, `technical`. */
  type: string
}

export function boardItem(
  items: RawItem[] | undefined,
  board: { owner: string; number: number },
): Card | undefined {
  const raw = (items ?? []).find(
    (item) => item.project?.number === board.number && same(item.project.owner?.login, board.owner),
  )
  if (!raw) return undefined
  const field = (name: string) =>
    raw.fieldValues?.nodes?.find((value) => same(value?.field?.name, name))?.name
  return {
    itemId: raw.id,
    status: field('Status'),
    type: (field('Task Type') ?? 'technical').toLowerCase(),
  }
}

/** Un issue como lo devuelve `dependencies/blocking`: su repo sale de `repository_url`. */
export interface RawIssueRef {
  number: number
  state: string
  repository_url: string
}

export function issueRefs(issues: RawIssueRef[] | undefined, repos: string[]) {
  return (issues ?? []).flatMap((issue) => {
    const [owner, repo] = issue.repository_url.split('/repos/')[1]?.split('/') ?? []
    if (issue.state !== 'open' || !owner || !repo) return []
    if (!repos.some((full) => same(full, `${owner}/${repo}`))) return []
    return [{ owner, repo, number: issue.number }]
  })
}

export interface RawPr {
  number: number
  html_url: string
  state: string
  head: { sha: string }
}

/** El PR abierto de la task: el del evento si sigue abierto, si no el de su rama. */
export function openPr(byNumber: RawPr | undefined, byBranch: RawPr[] | undefined) {
  const pr = byNumber ? (byNumber.state === 'open' ? byNumber : undefined) : byBranch?.[0]
  return pr && { number: pr.number, url: pr.html_url, headSha: pr.head.sha }
}

/** Lo que `resolve-task.yaml` junta de GitHub para una task. */
export interface TaskInput {
  /** El evento a emitir (`issue_comment`, `issue.status_changed`, …). */
  emit: string
  owner: string
  repo: string
  number: number
  /** El PR del evento, si trae uno. */
  pr?: number
  /** Pisa el status del board (el `to` de un cambio de Status que el board todavía no refleja). */
  status?: string
  /** Campos propios del evento, en la raíz del payload. */
  extra?: Input
  comment?: { body: string; author: string; id: number }
  /** Un issue que se acaba de cerrar: no cuenta como bloqueador aunque GitHub todavía no lo haya
   *  cerrado — el webhook del merge puede llegar antes que el cierre. */
  closedBlocker?: string
  card: Card
  issue: {
    title: string
    body?: string | null
    html_url: string
    labels: Array<{ name: string } | string>
  }
  blockers?: Array<{ number: number; title: string; state: string; html_url: string }>
  issueComments?: RawComment[]
  openPr?: { number: number; url: string }
  prComments?: RawComment[]
  threads?: RawThread[]
  reviews?: RawReview[]
  checks?: Array<{ status: string; conclusion: string | null }>
  statuses?: Array<{ state: string }>
  projectId: string
  branchPrefix: string
  /** `{{project.repos}}` de los prompts. */
  repos: string
}

export function taskPayload(input: TaskInput) {
  const blockers = (input.blockers ?? []).filter(
    (b) => b.state === 'open' && b.html_url !== input.closedBlocker,
  )
  const status = input.status ?? input.card.status
  // Un `to` sin valor (GitHub no siempre lo manda en un cambio de Status) es el status que quedó.
  const extra =
    input.extra && 'to' in input.extra && input.extra.to === undefined
      ? { ...input.extra, to: status }
      : input.extra
  const args: EventArgs = {
    eventType: input.emit,
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    status,
    type: input.card.type,
    labels: [],
    author: input.comment?.author ?? '',
    commentId: input.comment?.id ?? 0,
    ...(input.comment ? { comment: input.comment.body } : {}),
    ...(input.pr !== undefined ? { pr: input.pr } : {}),
    ...(extra ? { extra } : {}),
    taskExtra: {
      comments: taskTimeline({ ...input, pr: input.openPr?.number }),
      ci: input.openPr
        ? rollupCi(
            input.checks ?? [],
            (input.statuses ?? []).map((s) => s.state),
          )
        : '',
      ...(input.openPr ? { pr: input.openPr } : {}),
      // `{{task.blockers}}`: qué la frena, legible para el prompt.
      blockers: blockers.map((b) => `#${b.number} ${b.title} (${b.html_url})`).join('\n'),
    },
    // Lo que filtra el gate de las pipelines (`item.blocked`): hay prerrequisitos abiertos.
    itemExtra: { blocked: blockers.length > 0 },
  }
  const issue = {
    title: input.issue.title,
    body: input.issue.body ?? '',
    url: input.issue.html_url,
    labels: input.issue.labels.map((label) => (typeof label === 'string' ? label : label.name)),
  }
  const task = `${input.owner}/${input.repo}#${input.number}`
  return {
    type: input.emit,
    blocked: blockers.length > 0,
    payload: assemblePayload(args, issue, {
      repos: input.repos,
      branchPrefix: input.branchPrefix,
    }),
    // `repo`/`issue` además del proyecto: la telemetría los hereda a todo lo que corre debajo.
    scope: { projectId: input.projectId, repo: `${input.owner}/${input.repo}`, issue: task },
  }
}
