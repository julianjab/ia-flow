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

import type { PullRequestRef } from '@ia-flow/shared'
import { createLogger } from '../logger.js'
import { gql } from './client.js'

export type { PullRequestRef }

const log = createLogger('github-dev-links')

export interface IssueDevLinks {
  /** Branch linkeada al issue; la del repo primario cuando hay varias. */
  branch?: string
  /** Repo al que pertenece `branch`. No siempre es el repo primario del issue
   * (GitHub deja linkear una branch de otro repo), y sin esto un link a la
   * branch apuntaría al repo equivocado. */
  branchRepo?: string
  /** Owner del repo de `branch` — puede no ser el owner del proyecto (fork). */
  branchOwner?: string
  pullRequests: PullRequestRef[]
  /** false ⇒ no sabemos si hay PRs (el endpoint no soporta el campo y se
   * degradó la selección). Distinto de `pullRequests: []`, que sí afirma que
   * no hay ninguno — un "no sé" nunca debe dibujarse como "no hay". */
  pullRequestsKnown: boolean
}

export const EMPTY_DEV_LINKS: IssueDevLinks = { pullRequests: [], pullRequestsKnown: false }

export interface LinkedBranchNode {
  ref?: { name?: string; repository?: { name?: string; owner?: { login?: string } } } | null
}

interface RawPullRequestNode {
  id?: string
  number?: number
  url?: string
  state?: string
  isDraft?: boolean
  merged?: boolean
  title?: string
  headRefName?: string
  headRepository?: { name?: string; owner?: { login?: string } } | null
  commits?: {
    nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } | null } | null>
  } | null
}

const CI_STATES = ['success', 'failure', 'error', 'pending', 'expected'] as const
type CiState = (typeof CI_STATES)[number]

function mapCiState(raw: RawPullRequestNode): CiState | undefined {
  const state = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state?.toLowerCase()
  return CI_STATES.find((s) => s === state)
}

/** Shape que `issueDevLinksSelection()` produce sobre un nodo Issue. */
export interface RawDevLinks {
  linkedBranches?: { nodes?: LinkedBranchNode[] } | null
  closedByPullRequestsReferences?: { nodes?: RawPullRequestNode[] } | null
}

// ─── Selección GraphQL ────────────────────────────────────────────────────

const LINKED_BRANCHES_SELECTION = `
  linkedBranches(first: 5) {
    nodes { ref { name repository { name owner { login } } } }
  }
`

// `id` (node id v4) va acá y no en una query aparte porque es gratis: ya
// estamos pidiendo estos nodos. Es lo que después deja comentar en el PR y leer
// sus comentarios con `addComment(subjectId:)` / `nodes(ids:)` sin un request
// por PR para traducir número → node id.
// `statusCheckRollup` cuelga del ÚLTIMO commit del PR — GitHub no lo expone en
// el PR mismo. Es lo que contesta "¿el CI ya terminó?" sin un request por PR a
// la API de checks. `null` cuando el commit no tiene ningún check configurado,
// que no es lo mismo que estar corriendo (ver `isCiFinished`).
const PULL_REQUESTS_SELECTION = `
  closedByPullRequestsReferences(first: 5, includeClosedPrs: true) {
    nodes {
      id number url state isDraft merged title
      headRefName
      headRepository { name owner { login } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
`

// El campo se apaga SOLO ante un error de schema (el endpoint no lo conoce),
// nunca ante un fallo transitorio que casualmente lo nombre — apagarlo de más
// dejaría a todo el proceso mintiendo "sin PR". Y se re-habilita solo pasado
// el TTL, así un rollout de schema de GitHub se recupera sin reiniciar.
const PR_FIELD_RETRY_MS = 30 * 60 * 1000
let pullRequestFieldOffUntil: number | null = null

function pullRequestFieldSupported(): boolean {
  if (pullRequestFieldOffUntil === null) return true
  if (Date.now() < pullRequestFieldOffUntil) return false
  pullRequestFieldOffUntil = null
  return true
}

/** ¿La última selección pidió PRs? Lo que separa "no hay PRs" de "no sé". */
export function arePullRequestsKnown(): boolean {
  return pullRequestFieldOffUntil === null
}

/** Fragmento a inyectar dentro de un `... on Issue { … }`. */
export function issueDevLinksSelection(): string {
  return pullRequestFieldSupported()
    ? `${LINKED_BRANCHES_SELECTION}${PULL_REQUESTS_SELECTION}`
    : LINKED_BRANCHES_SELECTION
}

// Los mensajes de schema de GitHub: "Field 'x' doesn't exist on type 'Issue'"
// y "Undefined field 'x' on type 'Issue'". Exigimos las DOS partes — el nombre
// del campo y la frase de schema — para no confundir un 502 o un error parcial
// que mencione el campo con "este endpoint no lo tiene".
const SCHEMA_ERROR_PHRASES = ["doesn't exist", 'does not exist', 'undefined field']

export function isUnsupportedPullRequestFieldError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (!msg.includes('closedbypullrequestsreferences')) return false
  return SCHEMA_ERROR_PHRASES.some((phrase) => msg.includes(phrase))
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
    if (!pullRequestFieldSupported() || !isUnsupportedPullRequestFieldError(err)) throw err
    pullRequestFieldOffUntil = Date.now() + PR_FIELD_RETRY_MS
    log.warn(
      { err: (err as Error).message },
      'closedByPullRequestsReferences no soportado — se sigue sin info de PRs',
    )
    return run()
  }
}

/** Test seam: vuelve a habilitar la selección de PRs. */
export function resetDevLinksSupport(): void {
  pullRequestFieldOffUntil = null
}

// ─── Mapeo ────────────────────────────────────────────────────────────────

/** El ref del repo primario si alguno matchea; si no, el primero. */
export function pickPrimaryBranchRef(
  nodes: LinkedBranchNode[] | undefined,
  primaryRepoName: string | undefined,
): { name: string; repo?: string; owner?: string } | undefined {
  const list = nodes ?? []
  if (!list.length) return undefined
  const sameRepo = primaryRepoName
    ? list.find((n) => n.ref?.repository?.name === primaryRepoName)
    : undefined
  const ref = (sameRepo ?? list[0])?.ref
  if (!ref?.name) return undefined
  return {
    name: ref.name,
    ...(ref.repository?.name ? { repo: ref.repository.name } : {}),
    ...(ref.repository?.owner?.login ? { owner: ref.repository.owner.login } : {}),
  }
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
  const ci = mapCiState(raw)
  return {
    number: raw.number,
    url: raw.url,
    state,
    isDraft: raw.isDraft === true,
    ...(raw.id ? { nodeId: raw.id } : {}),
    ...(raw.title ? { title: raw.title } : {}),
    ...(raw.headRefName ? { headRefName: raw.headRefName } : {}),
    ...(raw.headRepository?.name ? { headRepo: raw.headRepository.name } : {}),
    ...(raw.headRepository?.owner?.login ? { headOwner: raw.headRepository.owner.login } : {}),
    ...(ci ? { ci } : {}),
  }
}

/**
 * ¿El CI de este PR ya terminó? Es el gate del pedido de review: taguear a un
 * revisor mientras el build corre lo hace mirar un PR que todavía puede
 * romperse.
 *
 * Un PR **sin checks** (`ci` ausente) cuenta como terminado: no hay nada que
 * esperar, y tratarlo como "corriendo" dejaría a todo repo sin CI con el botón
 * apagado para siempre.
 */
export function isCiFinished(pr: Pick<PullRequestRef, 'ci'>): boolean {
  return pr.ci !== 'pending' && pr.ci !== 'expected'
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
  const branchOwner = ref?.name ? ref.owner : fromPr?.headOwner
  return {
    ...(branch ? { branch } : {}),
    ...(branchRepo ? { branchRepo } : {}),
    ...(branchOwner ? { branchOwner } : {}),
    pullRequests,
    pullRequestsKnown: arePullRequestsKnown(),
  }
}

/**
 * Los PRs abiertos de un issue, con node id — los únicos sobre los que el
 * pipeline lee y escribe.
 *
 * Cerrado o mergeado queda afuera en las DOS direcciones, y por el mismo
 * motivo: comentar en un PR mergeado es carta muerta, y leer los comentarios de
 * un intento abandonado mete ruido que compite con el intento vivo. Un `draft`
 * SÍ entra: está abierto y es donde está el trabajo.
 *
 * Sin `nodeId` no sirve para ninguna de las dos cosas, así que se filtra
 * también por eso (una fila vieja cacheada puede no traerlo).
 */
export function openPullRequests(prs: readonly PullRequestRef[] | undefined): PullRequestRef[] {
  return (prs ?? []).filter((pr) => pr.state === 'open' && !!pr.nodeId)
}

/** URL al árbol de la branch. Codifica segmento a segmento: `encodeURIComponent`
 * sobre el nombre entero convertiría las `/` de `fix/algo` en `%2F` y GitHub
 * devolvería 404. */
export function branchTreeUrl(owner: string, repo: string, branch: string): string {
  const ref = branch.split('/').map(encodeURIComponent).join('/')
  return `https://github.com/${owner}/${repo}/tree/${ref}`
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
