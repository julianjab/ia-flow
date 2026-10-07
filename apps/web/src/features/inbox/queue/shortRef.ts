// El nombre corto de un repo para el link «seller#4281 ↗». Puro.
//
// La regla (sin un mapa por repo):
// 1. Se toma el nombre del repo sin el owner (`la-haus/lh-seller-v2-frontend` → `lh-seller-v2-frontend`).
// 2. Se parte en `-` y se quitan, al principio, los prefijos de organización (`lh`) y, al final,
//    las versiones (`v2`) y las palabras de capa (`frontend`, `backend`, `web`, `app`…).
//    Siempre queda al menos una palabra: `acme/api` sigue siendo `api`.
// 3. Si lo que queda es una sola palabra de más de 10 letras, se recorta a sus 4 primeras
//    (`subscriptions` → `subs`). Un nombre de varias palabras (`ia-flow`) queda entero.

const ORG_PREFIXES = new Set(['lh'])
const LAYER_SUFFIXES = new Set([
  'frontend',
  'backend',
  'front',
  'back',
  'fe',
  'be',
  'web',
  'app',
  'api',
  'service',
  'svc',
])
const VERSION = /^v\d+$/
const LONG_WORD = 10
const CUT = 4

/** `lh-seller-v2-frontend` → `seller`, `subscriptions` → `subs`. Acepta `owner/repo` o `repo`. */
export function shortRepo(repo: string): string {
  const name = (repo.split('/').at(-1) ?? repo).toLowerCase()
  const words = name.split('-').filter(Boolean)
  if (words.length === 0) return name
  let start = 0
  let end = words.length
  while (end - start > 1 && ORG_PREFIXES.has(words[start] ?? '')) start++
  while (end - start > 1) {
    const last = words[end - 1] ?? ''
    if (!VERSION.test(last) && !LAYER_SUFFIXES.has(last)) break
    end--
  }
  const kept = words.slice(start, end)
  const only = kept[0] ?? name
  if (kept.length === 1 && only.length > LONG_WORD) return only.slice(0, CUT)
  return kept.join('-')
}

/** `la-haus/lh-seller-v2-frontend#4281` → `seller#4281`. Un ref sin `#` vuelve tal cual. */
export function shortRef(ref: string): string {
  const hash = ref.lastIndexOf('#')
  if (hash < 0) return ref
  return `${shortRepo(ref.slice(0, hash))}${ref.slice(hash)}`
}

/**
 * La URL de GitHub de un ref `owner/repo#n` (el issue: GitHub redirige al PR si lo es). Un ref
 * que no tiene esa forma no tiene link: `undefined`.
 */
export function refUrl(ref: string): string | undefined {
  const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ref)
  if (!match) return undefined
  return `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`
}

/** El PR de una tarea con el mismo repo corto que su issue: `seller#4302`. Sin PR, `''`. */
export function prShortOf(item: { ref: string; pr?: { number: number } | null }): string {
  if (!item.pr) return ''
  const hash = item.ref.lastIndexOf('#')
  const repo = hash < 0 ? item.ref : item.ref.slice(0, hash)
  return shortRef(`${repo}#${item.pr.number}`)
}
