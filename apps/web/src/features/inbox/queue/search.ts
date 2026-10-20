// El buscador de la bandeja (el mismo del menubar, `RunnerSearch.swift`): interpreta lo que se
// escribe —un número, `repo#n`, `owner/repo#n`, el link de un issue o PR de GitHub, o texto del
// título— y junta lo que coincide en la bandeja, «Por arrancar» y el resto del board. Puro.

import type { InboxItem } from '@ia-flow/shared'
import { shortRef } from '@/features/inbox/queue/shortRef'

export interface Search {
  owner?: string
  repo?: string
  number?: number
  /** Texto libre, en palabras normalizadas: se busca aproximado en el título y el repo. */
  words?: string[]
  raw: string
}

/** Lo que se busca, o `null` si no se escribió nada. */
export function parseSearch(input: string): Search | null {
  const raw = input.trim()
  if (!raw) return null
  // https://github.com/owner/repo/issues/12, /pull/12, con o sin #comentario
  let m = /github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/i.exec(raw)
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]), raw }
  // owner/repo#12, owner/repo 12
  m = /^([\w.-]+)\/([\w.-]+)\s*[#\s]\s*(\d+)$/.exec(raw)
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]), raw }
  // repo#12, repo 12
  m = /^([A-Za-z][\w.-]*)\s*[#\s]\s*(\d+)$/.exec(raw)
  if (m) return { repo: m[1], number: Number(m[2]), raw }
  // 12, #12
  m = /^#?(\d+)$/.exec(raw)
  if (m) return { number: Number(m[1]), raw }
  return { words: words(raw), raw }
}

/** `owner/repo#n` de una ref, o `null`. */
export function splitRef(ref: string): { owner: string; repo: string; number: number } | null {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref)
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null
}

/**
 * Coincide si el número es el mismo —el del issue o el de su PR, así sirve pegar el link del PR—
 * y el repo (y el owner, si se dio) también; el texto, por título o repo.
 */
export function matches(search: Search, ref: string, title: string, pr?: number): boolean {
  if (search.words) {
    // del ref, sólo el repo: el owner (`la-haus`) está en todas y haría coincidir cualquier cosa
    const haystack = words(`${title} ${splitRef(ref)?.repo ?? ref}`)
    return search.words.length > 0 && search.words.every((w) => haystack.some((c) => close(w, c)))
  }
  const parts = splitRef(ref)
  if (!parts) return false
  if (search.number !== undefined && parts.number !== search.number && pr !== search.number)
    return false
  if (search.repo && parts.repo.toLowerCase() !== search.repo.toLowerCase()) return false
  if (search.owner && parts.owner.toLowerCase() !== search.owner.toLowerCase()) return false
  return true
}

/** Sin tildes ni mayúsculas, partido en palabras (`assignable_stages` → `assignable`, `stages`). */
export function words(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * La palabra buscada aparece en la del título (prefijo o adentro, desde 3 letras) o está a un typo
 * de ella: 1 letra de diferencia en palabras de 4 a 6, 2 desde 7.
 */
export function close(word: string, candidate: string): boolean {
  if (candidate === word) return true
  if (word.length >= 3 ? candidate.includes(word) : candidate.startsWith(word)) return true
  const allowed = word.length >= 7 ? 2 : word.length >= 4 ? 1 : 0
  if (allowed === 0) return false
  if (Math.abs(candidate.length - word.length) <= allowed)
    return distance(word, candidate) <= allowed
  // «perfil» contra «perfilado»: el typo puede estar en el prefijo de una palabra más larga
  return (
    candidate.length > word.length && distance(word, candidate.slice(0, word.length)) <= allowed
  )
}

/** Distancia de Levenshtein (palabras cortas: alcanza con dos filas). */
export function distance(a: string, b: string): number {
  if (!a) return b.length
  if (!b) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

/** Una card que coincide, con dónde está: la bandeja, «Por arrancar» o su columna del board. */
export interface SearchHit {
  ref: string
  short: string
  url: string
  title: string
  where: string
  pr?: number
}

interface Card {
  ref: string
  title: string
  url: string
  status?: string
  pr?: { number: number }
  epic?: { ref: string; title: string }
}

/** De dónde sale cada card: la bandeja (con su lugar), Todo y el resto del board. Sólo la
 *  bandeja trae la épica: buscarla trae sus tareas. */
export interface SearchSources {
  items: readonly (Card & { group: InboxItem['group'] })[]
  ready: readonly Card[]
  waiting: readonly Card[]
  rest: readonly { status: string; items: readonly Card[] }[]
}

const GROUP_WHERE: Partial<Record<InboxItem['group'], string>> = {
  need: 'te necesita',
  fail: 'falló',
  run: 'corriendo',
  queue: 'en cola',
}

/**
 * Lo que coincide, cada card una vez y en el orden en que importa: la bandeja, lo que puede
 * arrancar, lo que espera a otra y el resto del board. En la bandeja, buscar una épica trae sus
 * tareas.
 */
export function searchCards(search: Search, sources: SearchSources, limit = 50): SearchHit[] {
  const hit = (card: Card) =>
    matches(search, card.ref, card.title, card.pr?.number) ||
    (card.epic !== undefined && matches(search, card.epic.ref, card.epic.title))
  const candidates: [Card, string][] = [
    ...sources.items.map((i): [Card, string] => [
      i,
      GROUP_WHERE[i.group] ?? i.status ?? 'en la bandeja',
    ]),
    ...sources.ready.map((c): [Card, string] => [c, 'puede arrancar']),
    ...sources.waiting.map((c): [Card, string] => [c, 'espera a otra']),
    ...sources.rest.flatMap((col) => col.items.map((c): [Card, string] => [c, col.status])),
  ]
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (const [card, where] of candidates) {
    if (seen.has(card.ref) || !hit(card)) continue
    seen.add(card.ref)
    const { ref, url, title } = card
    hits.push({ ref, short: shortRef(ref), url, title, where, pr: card.pr?.number })
  }
  return hits.slice(0, limit)
}

/**
 * La ref exacta que se escribió (`owner/repo#n`, o `repo#n` con el owner de otra card de ese
 * repo), para abrirla aunque no esté en ningún lado. `null` si no alcanza para armarla.
 */
export function exactRef(search: Search, known: readonly string[]): string | null {
  if (search.number === undefined || !search.repo) return null
  if (search.owner) return `${search.owner}/${search.repo}#${search.number}`
  const repo = search.repo.toLowerCase()
  const owner = known.map(splitRef).find((p) => p?.repo.toLowerCase() === repo)?.owner
  return owner ? `${owner}/${search.repo}#${search.number}` : null
}

/** La búsqueda en GitHub (issues y PRs de la organización), para lo que no está en el board. */
export function githubSearchUrl(search: Search, org: string | null): string {
  const q = org ? `org:${org} ${search.raw}` : search.raw
  return `https://github.com/search?q=${encodeURIComponent(q)}&type=issues`
}
