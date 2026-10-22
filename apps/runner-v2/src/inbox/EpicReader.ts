/**
 * Una épica con todos sus sub-issues (`GET /api/tasks/:owner/:repo/:n/epic`): los lee de GitHub con
 * la identidad del runner —estén o no en un board— y a los que son cards les suma su columna, sus
 * bloqueos y su PR. Lo que la bandeja trae de la épica es sólo su avance (`done/total`).
 */
import type { GithubClient } from '@ia-flow/github-api'
import type { BoardCard } from '@ia-flow/github-tools'
import type { EpicChild, EpicDetail } from '@ia-flow/shared'

/** Tope de sub-issues que se leen: GitHub permite hasta 100 por padre. */
const MAX_CHILDREN = 100

interface RawSubIssue {
  number: number
  title: string
  url: string
  state: string
  repository: { name: string; owner: { login: string } }
}

interface EpicPage {
  repository?: {
    issue?: {
      number: number
      title: string
      url: string
      subIssuesSummary?: { completed: number; total: number } | null
      subIssues?: { nodes: RawSubIssue[] } | null
    } | null
  } | null
}

const epicQuery = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number title url
      subIssuesSummary { completed total }
      subIssues(first: ${MAX_CHILDREN}) {
        nodes { number title url state repository { name owner { login } } }
      }
    }
  }
}`

const REF_RE = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/

/** Un hijo de la épica; si es una card, con su columna, sus bloqueos y su PR. */
function toChild(raw: RawSubIssue, card: BoardCard | undefined): EpicChild {
  const ref = `${raw.repository.owner.login}/${raw.repository.name}#${raw.number}`
  const open = raw.state === 'OPEN'
  return {
    ref,
    title: raw.title,
    url: raw.url,
    state: open ? 'open' : 'closed',
    ...(open && card?.status ? { status: card.status } : {}),
    ...(open && card?.blockedBy.length ? { blocked_by: card.blockedBy } : {}),
    ...(open && card?.pr ? { pr: card.pr } : {}),
  }
}

/** La épica de la respuesta de GraphQL, con sus hijos cruzados con las cards (`card`). */
export function toEpicDetail(
  ref: string,
  data: EpicPage,
  card: (ref: string) => BoardCard | undefined,
): EpicDetail | undefined {
  const issue = data.repository?.issue
  if (!issue) return undefined
  const children = (issue.subIssues?.nodes ?? []).map((raw) =>
    toChild(raw, card(`${raw.repository.owner.login}/${raw.repository.name}#${raw.number}`)),
  )
  return {
    epic: {
      ref,
      title: issue.title,
      url: issue.url,
      done:
        issue.subIssuesSummary?.completed ?? children.filter((c) => c.state === 'closed').length,
      total: issue.subIssuesSummary?.total ?? children.length,
    },
    children,
  }
}

export class EpicReader {
  constructor(
    private readonly client: GithubClient,
    /** Las cards abiertas de los boards del runner. */
    private readonly cards: () => Promise<BoardCard[]>,
  ) {}

  /** La épica `owner/repo#n` y sus sub-issues; un issue que no existe (o no se ve), `undefined`. */
  async detail(ref: string): Promise<EpicDetail | undefined> {
    const m = REF_RE.exec(ref)
    if (!m) return undefined
    const [, owner, repo, number] = m
    const [data, cards] = await Promise.all([
      this.client
        .graphql<EpicPage>(epicQuery, { owner, repo, number: Number(number) })
        .catch((err: unknown) => {
          // GitHub contesta un issue o repo inexistente como error de GraphQL.
          if (err instanceof Error && err.message.includes('Could not resolve')) return {}
          throw err
        }),
      this.cards(),
    ])
    const byRef = new Map(cards.map((card) => [card.ref, card]))
    return toEpicDetail(ref, data, (child) => byRef.get(child))
  }
}
