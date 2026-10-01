/**
 * Lo que GitHub devuelve de una task, en formas chicas y puras — sin I/O:
 *
 *   boardItem   la card de un board entre los items de un issue (status y tipo)
 *   issueRefs   los issues abiertos de una lista de GitHub, de los repos de un catálogo
 *   openPr      el PR abierto de una task
 *
 * Las lee `GithubTaskReader`; el runner arma con ellas el evento de la task.
 */
const same = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

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
  title?: string
  user?: { login: string }
  head: { sha: string; ref?: string }
  base?: { ref: string }
}

/** El PR abierto de la task, en `task.pr`. */
export interface OpenPr {
  number: number
  url: string
  headSha: string
  title: string
  author: string
  headRef: string
  baseRef: string
}

/** El PR de la task en `task.pr`, si sigue abierto. Cuál es lo dice GitHub (el del evento, o el que
 *  cierra el issue), no el nombre de su rama. */
export function openPr(pr: RawPr): OpenPr | undefined {
  if (pr.state !== 'open') return undefined
  return {
    number: pr.number,
    url: pr.html_url,
    headSha: pr.head.sha,
    title: pr.title ?? '',
    author: pr.user?.login ?? '',
    headRef: pr.head.ref ?? '',
    baseRef: pr.base?.ref ?? '',
  }
}
