import { onScopeDispose, ref, watch } from 'vue'
import {
  createGithubSearchApi,
  GithubApiError,
  type GithubIssue,
  type GithubSearchApi,
} from '@/features/github-search/api'
import { numberCandidates, planSearch, type SearchPlan } from '@/features/github-search/query'

// El estado de «Buscar en GitHub» (el de `GithubSearchModel.swift` del menú): lo escrito, el repo
// elegido (recordado por org en este navegador), los repos de la org (una vez por hora) y lo que
// encontró GitHub. Espera a que se deje de escribir y descarta la respuesta de una búsqueda vieja.

interface Deps {
  /** La organización: el owner de los boards del runner; `null` mientras no se sabe. */
  org: () => string | null
  /** El token del login de GitHub; `null` = sin sesión (no se manda nada). */
  token: () => Promise<string | null>
  api?: (token: string) => GithubSearchApi
  /** Cuánto esperar a que se deje de escribir (ms). */
  delay?: number
  /** Los repos del board (sólo el nombre): con un número en toda la org, se buscan primero. */
  boardRepos?: () => readonly string[]
}

/** Lo que muestra una búsqueda: los resultados o por qué no hay. */
interface Outcome {
  found: GithubIssue[]
  note: string | null
  /** No hay login: se ofrece iniciar sesión. */
  login?: boolean
}

const HOUR = 3_600_000
/** Los repos por org, una vez por hora: son cientos y casi no cambian. */
const repoCache = new Map<string, { at: number; names: string[] }>()

export function clearRepoCache(): void {
  repoCache.clear()
}

const repoKey = (org: string) => `ia-flow:github-search:repo:${org.toLowerCase()}`

function readRepo(org: string | null): string | null {
  if (!org) return null
  try {
    return localStorage.getItem(repoKey(org)) || null
  } catch {
    return null
  }
}

function saveRepo(org: string, repo: string | null): void {
  try {
    if (repo) localStorage.setItem(repoKey(org), repo)
    else localStorage.removeItem(repoKey(org))
  } catch {
    // Sin almacenamiento (modo privado): sólo no se recuerda.
  }
}

export function useGithubSearch(deps: Deps) {
  const makeApi = deps.api ?? ((token: string) => createGithubSearchApi(token))
  const delay = deps.delay ?? 350

  const query = ref('')
  /** El repo donde se busca (sólo el nombre); `null` = toda la organización. */
  const repo = ref<string | null>(readRepo(deps.org()))
  const repos = ref<string[]>([])
  const results = ref<GithubIssue[]>([])
  /** Por qué no hay resultados que mostrar (falta elegir repo, sin login, un error de GitHub). */
  const note = ref<string | null>(null)
  const needsLogin = ref(false)
  const searching = ref(false)
  const loadingRepos = ref(false)

  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  function show(out: Outcome): void {
    results.value = out.found
    note.value = out.note
    needsLogin.value = out.login ?? false
  }

  /** Lo que se le pide a GitHub según el plan, y lo que se muestra con su respuesta. */
  async function ask(
    plan: Exclude<SearchPlan, { kind: 'note' }>,
    raw: string,
    org: string,
    scope: string | null,
  ): Promise<Outcome> {
    const token = await deps.token().catch(() => null)
    if (!token)
      return {
        found: [],
        note: `Inicia sesión con GitHub para buscar en los repos de ${org}.`,
        login: true,
      }
    const api = makeApi(token)
    try {
      if (plan.kind === 'ref') {
        const issue = await api.issue(plan.ref)
        return issue
          ? { found: [issue], note: null }
          : { found: [], note: `${plan.ref} no existe o tu login no lo puede ver.` }
      }
      if (plan.kind === 'number') return await askNumber(api, org, plan.number)
      const found = await api.search(plan.text, org, scope)
      return {
        found,
        note: found.length ? null : `Nada con «${raw}» en ${scope ?? `toda ${org}`}.`,
      }
    } catch (err) {
      const message = err instanceof GithubApiError ? err.message : String(err)
      return { found: [], note: `GitHub no respondió: ${message}` }
    }
  }

  /** Un número en toda la organización: GitHub no lo busca, así que se pide ese número en los repos
   *  del board y en los más activos, en paralelo, y se muestran todos los que existen. */
  async function askNumber(api: GithubSearchApi, org: string, n: number): Promise<Outcome> {
    if (!repos.value.length) await loadRepos()
    const where = numberCandidates(deps.boardRepos?.() ?? [], repos.value)
    const answers = await Promise.allSettled(where.map((name) => api.issue(`${org}/${name}#${n}`)))
    const found = answers.flatMap((a) => (a.status === 'fulfilled' && a.value ? [a.value] : []))
    const scopeNote = `Buscado en ${where.length} repos de ${org} (los del board y los más activos). Si es de otro, elige el repo.`
    return {
      found,
      note: found.length ? scopeNote : `Ningún #${n} en esos repos. ${scopeNote}`,
    }
  }

  async function run(raw: string, mine: number): Promise<void> {
    const org = deps.org()
    if (!org) return
    const scope = repo.value
    const plan = planSearch(raw, { org, repo: scope })
    if (!plan || plan.kind === 'note') {
      show({ found: [], note: plan?.note ?? null })
      return
    }
    searching.value = true
    const out = await ask(plan, raw, org, scope)
    if (mine !== seq) return
    searching.value = false
    show(out)
  }

  /** Busca cuando se deja de escribir; lo vacío limpia en el acto. */
  function schedule(): void {
    if (timer) clearTimeout(timer)
    const mine = ++seq
    const raw = query.value.trim()
    if (!raw) {
      searching.value = false
      show({ found: [], note: null })
      return
    }
    timer = setTimeout(() => void run(raw, mine), delay)
  }

  /** Los repos de la org, una vez por hora (con el login). */
  async function loadRepos(force = false): Promise<void> {
    const org = deps.org()
    if (!org || loadingRepos.value) return
    const cached = repoCache.get(org.toLowerCase())
    if (!force && cached && Date.now() - cached.at < HOUR) {
      repos.value = cached.names
      return
    }
    loadingRepos.value = true
    try {
      const token = await deps.token().catch(() => null)
      if (!token) return
      const names = await makeApi(token).repos(org)
      repoCache.set(org.toLowerCase(), { at: Date.now(), names })
      if (deps.org() === org) repos.value = names
    } catch {
      // Sin la lista se puede igual buscar en toda la org o en los del board.
    } finally {
      loadingRepos.value = false
    }
  }

  function select(name: string | null): void {
    repo.value = name
  }

  /** Al entrar o salir de GitHub: los repos y la búsqueda otra vez («Inicia sesión» ya no aplica). */
  function sessionChanged(): void {
    void loadRepos(true)
    schedule()
  }

  watch(query, schedule)
  watch(repo, (next) => {
    const org = deps.org()
    if (org) saveRepo(org, next)
    schedule()
  })
  // La org llega con la bandeja: su repo recordado, sus repos y lo que ya se había escrito.
  watch(deps.org, (org, before) => {
    if (!org || org === before) return
    repo.value = readRepo(org)
    void loadRepos()
    schedule()
  })

  onScopeDispose(() => {
    if (timer) clearTimeout(timer)
    seq++
  })

  return {
    query,
    repo,
    repos,
    results,
    note,
    needsLogin,
    searching,
    loadingRepos,
    select,
    loadRepos,
    sessionChanged,
    schedule,
  }
}
