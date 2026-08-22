// "Development links" de un issue de GitHub: la branch del Development panel
// (`linkedBranches`) y los PRs que lo cierran (`closedByPullRequestsReferences`).
//
// Vive acá — y no dentro de cada source — porque los dos sources de GitHub
// necesitan exactamente los mismos campos y el mismo mapeo, pero los piden
// desde queries distintas: GitHubProjectSource los cuelga de su bulk
// `items(first: 100)` y GitHubIssueSource los pide con un `nodes(ids: [...])`
// aparte. Lo compartido es la SELECCIÓN y el mapper, no la query: así ninguna
// de las dos necesita un request por issue para saber si hay rama o PR.
//
// `closedByPullRequestsReferences` es relativamente nuevo en el schema de
// GitHub. Si el endpoint no lo conoce, la query entera fallaría y se llevaría
// puesto el listado de items — por eso `withDevLinksFallback` degrada una sola
// vez a la selección sin PRs en vez de dejar la app sin tareas.

import { createLogger } from '../logger.js'
import { gql } from './client.js'

const log = createLogger('github-dev-links')

export interface PullRequestRef {
  number: number
  url: string
  /** `merged` no es un state nativo (GitHub lo modela como un PR cerrado con
   * `merged: true`) — se colapsa acá porque es la distinción que importa. */
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  title?: string
  /** Branch de origen del PR. Es la rama real del trabajo cuando el issue
   * quedó vinculado por el PR y no por el Development panel. */
  headRefName?: string
  headRepo?: string
}

export interface IssueDevLinks {
  /** Branch linkeada al issue; la del repo primario cuando hay varias. */
  branch?: string
  /** Repo al que pertenece `branch`. No siempre es el repo primario del issue
   * (GitHub deja linkear una branch de otro repo), y sin esto un link a la
   * branch apuntaría al repo equivocado. */
  branchRepo?: string
  pullRequests: PullRequestRef[]
}

export const EMPTY_DEV_LINKS: IssueDevLinks = { pullRequests: [] }

export interface LinkedBranchNode {
  ref?: { name?: string; repository?: { name?: string } } | null
}

interface RawPullRequestNode {
  number?: number
  url?: string
  state?: string
  isDraft?: boolean
  merged?: boolean
  title?: string
  headRefName?: string
  headRepository?: { name?: string } | null
}

/** Shape que `issueDevLinksSelection()` produce sobre un nodo Issue. */
export interface RawDevLinks {
  linkedBranches?: { nodes?: LinkedBranchNode[] } | null
  closedByPullRequestsReferences?: { nodes?: RawPullRequestNode[] } | null
}

// ─── Selección GraphQL ────────────────────────────────────────────────────

const LINKED_BRANCHES_SELECTION = `
  linkedBranches(first: 5) {
    nodes { ref { name repository { name } } }
  }
`

const PULL_REQUESTS_SELECTION = `
  closedByPullRequestsReferences(first: 5, includeClosedPrs: true) {
    nodes { number url state isDraft merged title headRefName headRepository { name } }
  }
`

let pullRequestFieldSupported = true

/** Fragmento a inyectar dentro de un `... on Issue { … }`. */
export function issueDevLinksSelection(): string {
  return pullRequestFieldSupported
    ? `${LINKED_BRANCHES_SELECTION}${PULL_REQUESTS_SELECTION}`
    : LINKED_BRANCHES_SELECTION
}

export function isUnsupportedPullRequestFieldError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('closedByPullRequestsReferences')
}

/**
 * Corre `run()` y, si el endpoint no conoce `closedByPullRequestsReferences`,
 * apaga ese pedazo de la selección y reintenta una vez. `run` tiene que
 * construir la query adentro (no recibirla ya armada) para que el reintento use
 * la selección nueva.
 */
export async function withDevLinksFallback<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (!pullRequestFieldSupported || !isUnsupportedPullRequestFieldError(err)) throw err
    pullRequestFieldSupported = false
    log.warn(
      { err: (err as Error).message },
      'closedByPullRequestsReferences no soportado — se sigue sin info de PRs',
    )
    return run()
  }
}

/** Test seam: vuelve a habilitar la selección de PRs. */
export function resetDevLinksSupport(): void {
  pullRequestFieldSupported = true
}

// ─── Mapeo ────────────────────────────────────────────────────────────────

/** El ref del repo primario si alguno matchea; si no, el primero. */
export function pickPrimaryBranchRef(
  nodes: LinkedBranchNode[] | undefined,
  primaryRepoName: string | undefined,
): { name: string; repo?: string } | undefined {
  const list = nodes ?? []
  if (!list.length) return undefined
  const sameRepo = primaryRepoName
    ? list.find((n) => n.ref?.repository?.name === primaryRepoName)
    : undefined
  const ref = (sameRepo ?? list[0])?.ref
  if (!ref?.name) return undefined
  return { name: ref.name, ...(ref.repository?.name ? { repo: ref.repository.name } : {}) }
}

/** Solo el nombre — atajo para los llamadores que no necesitan el repo. */
export function pickPrimaryBranch(
  nodes: LinkedBranchNode[] | undefined,
  primaryRepoName: string | undefined,
): string | undefined {
  return pickPrimaryBranchRef(nodes, primaryRepoName)?.name
}

function mapPullRequest(raw: RawPullRequestNode): PullRequestRef | null {
  if (typeof raw.number !== 'number' || !raw.url) return null
  const state = raw.merged ? 'merged' : raw.state?.toUpperCase() === 'CLOSED' ? 'closed' : 'open'
  return {
    number: raw.number,
    url: raw.url,
    state,
    isDraft: raw.isDraft === true,
    ...(raw.title ? { title: raw.title } : {}),
    ...(raw.headRefName ? { headRefName: raw.headRefName } : {}),
    ...(raw.headRepository?.name ? { headRepo: raw.headRepository.name } : {}),
  }
}

export function mapDevLinks(
  raw: RawDevLinks | null | undefined,
  primaryRepoName: string | undefined,
): IssueDevLinks {
  const ref = pickPrimaryBranchRef(raw?.linkedBranches?.nodes, primaryRepoName)
  const pullRequests = (raw?.closedByPullRequestsReferences?.nodes ?? [])
    .map(mapPullRequest)
    .filter((pr): pr is PullRequestRef => pr !== null)
  // Sin linked branch pero con PR, la rama del trabajo existe igual: es el
  // head del PR. Sin este fallback un issue vinculado por PR (y no por el
  // Development panel) se mostraba como "sin rama" teniéndola.
  const fromPr = pullRequests.find((pr) => pr.headRefName)
  const branch = ref?.name ?? fromPr?.headRefName
  const branchRepo = ref?.name ? ref.repo : fromPr?.headRepo
  return {
    ...(branch ? { branch } : {}),
    ...(branchRepo ? { branchRepo } : {}),
    pullRequests,
  }
}

// ─── Fetch en bulk ────────────────────────────────────────────────────────

// `nodes(ids:)` acepta hasta 100 ids por request — el chunk es el techo del
// endpoint, no una decisión nuestra.
const NODES_CHUNK = 100

interface DevLinksNode extends RawDevLinks {
  id?: string
}

/**
 * Dev links de varios issues en un solo request cada 100 ids (no uno por
 * issue). Los ids que no resuelven a un Issue simplemente no aparecen en el
 * Map — el llamador trata "ausente" como "sin rama ni PR".
 */
export async function fetchIssueDevLinks(
  issueNodeIds: string[],
  primaryRepoName?: string,
): Promise<Map<string, IssueDevLinks>> {
  const out = new Map<string, IssueDevLinks>()
  for (let i = 0; i < issueNodeIds.length; i += NODES_CHUNK) {
    const ids = issueNodeIds.slice(i, i + NODES_CHUNK)
    if (!ids.length) continue
    const data = await withDevLinksFallback(() =>
      gql<{ nodes?: Array<DevLinksNode | null> }>(
        `query IssueDevLinks($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Issue {
              id
              ${issueDevLinksSelection()}
            }
          }
        }`,
        { ids },
      ),
    )
    for (const node of data?.nodes ?? []) {
      if (!node?.id) continue
      out.set(node.id, mapDevLinks(node, primaryRepoName))
    }
  }
  return out
}
