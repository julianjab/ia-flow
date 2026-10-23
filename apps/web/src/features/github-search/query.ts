// Qué hace «Buscar en GitHub» con lo escrito (el mismo criterio que el menú de Mac,
// `GithubSearchModel.swift`): un link, `owner/repo#n`, `repo#n` o —con un repo elegido— un número
// van directo a ese issue o PR; un texto busca en el título. Con toda la organización, un número
// pide elegir repo (GitHub no busca por número en toda la org) y el texto pide 3 letras. Puro.

export interface ParsedQuery {
  owner?: string
  repo?: string
  number?: number
  /** Texto libre: se busca en el título. */
  text?: string
}

/** Lo que se escribió, o `null` si no hay nada. */
export function parseQuery(input: string): ParsedQuery | null {
  const raw = input.trim()
  if (!raw) return null
  // https://github.com/owner/repo/issues/12, /pull/12, con o sin #comentario
  let m = /github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/i.exec(raw)
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) }
  // owner/repo#12, owner/repo 12
  m = /^([\w.-]+)\/([\w.-]+)\s*[#\s]\s*(\d+)$/.exec(raw)
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) }
  // repo#12, repo 12
  m = /^([A-Za-z][\w.-]*)\s*[#\s]\s*(\d+)$/.exec(raw)
  if (m) return { repo: m[1], number: Number(m[2]) }
  // 12, #12
  m = /^#?(\d+)$/.exec(raw)
  if (m) return { number: Number(m[1]) }
  return { text: raw }
}

/** Qué pedirle a GitHub: un issue o PR por su ref, una búsqueda por título, o por qué no se pide nada. */
export type SearchPlan =
  | { kind: 'ref'; ref: string }
  | { kind: 'text'; text: string }
  | { kind: 'note'; note: string }

export function planSearch(
  input: string,
  scope: { org: string; repo: string | null },
): SearchPlan | null {
  const q = parseQuery(input)
  if (!q) return null
  if (q.number !== undefined) {
    if (q.repo) return { kind: 'ref', ref: `${q.owner ?? scope.org}/${q.repo}#${q.number}` }
    if (scope.repo) return { kind: 'ref', ref: `${scope.org}/${scope.repo}#${q.number}` }
    return {
      kind: 'note',
      note: `Elige un repo para buscar #${q.number}: GitHub no busca por número en toda la organización.`,
    }
  }
  const text = q.text ?? ''
  if (text.length < 3) return { kind: 'note', note: 'Escribe al menos 3 letras.' }
  return { kind: 'text', text }
}

/** `owner/repo#n` partido, o `null`. */
export function splitRef(ref: string): { owner: string; repo: string; number: number } | null {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref)
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null
}

/** Los repos del board primero (los de todos los días), después el resto por actividad; filtrados
 *  por lo escrito (sin mayúsculas, en cualquier parte del nombre). */
export function shownRepos(
  board: readonly string[],
  all: readonly string[],
  filter: string,
): { board: string[]; others: string[] } {
  const f = filter.trim().toLowerCase()
  const matches = (name: string) => !f || name.toLowerCase().includes(f)
  const inBoard = new Set(board.map((r) => r.toLowerCase()))
  return {
    board: board.filter(matches),
    others: all.filter((r) => !inBoard.has(r.toLowerCase()) && matches(r)),
  }
}

/** Los nombres de los repos del board de la org (`projects[].repos` trae `owner/repo`), sin repetir. */
export function boardRepoNames(repos: readonly string[], org: string): string[] {
  const names: string[] = []
  for (const full of repos) {
    const [owner, name] = full.split('/')
    if (!name || owner?.toLowerCase() !== org.toLowerCase()) continue
    if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name)
  }
  return names
}

/** La misma búsqueda en github.com (el ↗ explícito, en otra pestaña). */
export function githubWebUrl(input: string, scope: { org: string; repo: string | null }): string {
  const where = scope.repo ? `repo:${scope.org}/${scope.repo}` : `org:${scope.org}`
  const q = `${input.trim()} ${where}`.trim()
  return `https://github.com/search?q=${encodeURIComponent(q)}&type=issues`
}
