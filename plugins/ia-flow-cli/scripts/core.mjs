// El núcleo del pipeline, **sin una sola llamada de I/O**.
//
// Ese es el criterio del corte contra `flow.mjs`, y no el tamaño: todo lo de
// acá es un predicado o una transformación sobre datos que ya están en
// memoria, así que se testea entero sin red, sin `gh` y sin disco. Es la misma
// razón por la que `agent-selection.ts` y `policy.ts` viven separados de sus
// consumidores en el engine.
//
// Lo que hay adentro, en orden:
//
//   YAML         parser del subconjunto que usa el runner.yaml
//   LABELS       el estado del pipeline codificado como label del issue
//   SELECCIÓN    qué agente aplica a este issue
//   TRANSICIONES qué le pasa al issue cuando el run termina
//   SALIDA       cómo un run declara por dónde salió
//   CONFIG       validación del runner.yaml
//   RENDER       las variables del prompt de un agente

// ═══ YAML — el parser del subconjunto que usa el runner.yaml ───────────────────

// Parser del subconjunto de YAML que necesita un `runner.yaml`.
//
// Existe por una sola razón: el plugin tiene que correr en CUALQUIER repo sin
// un `bun install` previo. Una dependencia —`yaml`, `js-yaml`— convierte
// "clonar y usar" en "instalar node_modules primero", que es exactamente la
// fricción que un plugin de CLI no puede pedir. El costo es este archivo; el
// beneficio es que `flow.mjs` corre con node o bun pelados.
//
// Qué soporta, que es lo que el schema del runner usa:
//   - mapas anidados por indentación, secuencias (`- `), y secuencias de mapas
//   - escalares: string, number, boolean, null (`~`, vacío)
//   - comillas simples y dobles, con escapes básicos en las dobles
//   - flow inline: `[a, b]` y `{ a: b }` (un nivel, sin anidar flow en flow)
//   - block scalars `|`, `|-`, `>`, `>-` — el prompt de un agente ES eso
//   - comentarios `#` de línea entera y al final de una línea
//
// Qué NO soporta, a propósito: anchors/alias, tags, documentos múltiples,
// claves complejas, indicadores de indentación (`|2`). Nada de eso aparece en
// un archivo de config escrito a mano, y soportarlo triplicaría la superficie
// que hay que testear.

/** Error con número de línea — un typo en el YAML tiene que decir dónde. */
export class YamlError extends Error {
  constructor(message, line) {
    super(line == null ? message : `${message} (línea ${line + 1})`)
    this.name = 'YamlError'
    this.line = line
  }
}

const indentOf = (line) => line.length - line.trimStart().length
const isBlank = (line) => line.trim() === ''
const isComment = (line) => line.trimStart().startsWith('#')
/** Una línea que no aporta estructura: se saltea en cualquier posición. */
const isIgnorable = (line) => isBlank(line) || isComment(line)

export function parseYaml(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const st = { lines, i: 0 }
  skipIgnorable(st)
  if (st.i >= lines.length) return null
  return parseBlock(st, indentOf(lines[st.i]))
}

function skipIgnorable(st) {
  while (st.i < st.lines.length && isIgnorable(st.lines[st.i])) st.i++
}

/** Un bloque es un mapa o una secuencia; lo decide la primera línea. */
function parseBlock(st, indent) {
  skipIgnorable(st)
  if (st.i >= st.lines.length) return null
  const line = st.lines[st.i]
  return line.trimStart().startsWith('- ') || line.trim() === '-'
    ? parseSeq(st, indent)
    : parseMap(st, indent)
}

function parseMap(st, indent) {
  const out = {}
  while (st.i < st.lines.length) {
    skipIgnorable(st)
    if (st.i >= st.lines.length) break
    const line = st.lines[st.i]
    const ind = indentOf(line)
    // Menos indentación cierra este mapa; más indentación acá es un error de
    // estructura (una clave hija sin su padre) — pero lo tratamos como cierre
    // para que el error salga del nivel de arriba, que tiene más contexto.
    if (ind !== indent) break
    if (line.trimStart().startsWith('- ')) break

    const { key, rest } = splitKey(line, st.i)
    st.i++
    out[key] = parseValue(st, indent, rest, st.i - 1)
  }
  return out
}

function parseSeq(st, indent) {
  const out = []
  while (st.i < st.lines.length) {
    skipIgnorable(st)
    if (st.i >= st.lines.length) break
    const line = st.lines[st.i]
    if (indentOf(line) !== indent) break
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('- ') && trimmed !== '-') break

    const rest = trimmed === '-' ? '' : trimmed.slice(2)
    if (rest.trim() === '') {
      // `-` pelado: el item es el bloque indentado que sigue.
      st.i++
      out.push(parseNested(st, indent))
      continue
    }
    if (looksLikeKey(rest)) {
      // `- id: refiner` — el item es un mapa que ARRANCA en la línea del guion.
      // El truco clásico: se reescribe la línea sacándole el `- ` y se parsea
      // como mapa a la columna donde empieza el contenido. Sin esto habría que
      // duplicar parseMap con un caso especial para su primera clave.
      const col = indent + 2
      st.lines[st.i] = ' '.repeat(col) + rest
      out.push(parseMap(st, col))
      continue
    }
    st.i++
    out.push(parseScalar(rest, st.i - 1))
  }
  return out
}

/** El valor de una clave: block scalar, escalar en la misma línea, o bloque hijo. */
function parseValue(st, indent, rest, lineNo) {
  const head = rest.trim()
  if (head === '|' || head === '|-' || head === '>' || head === '>-') {
    return parseBlockScalar(st, indent, head)
  }
  if (head !== '') return parseScalar(head, lineNo)
  return parseNested(st, indent)
}

/** El bloque indentado que sigue a una clave o a un `-` sin valor. */
function parseNested(st, indent) {
  const save = st.i
  skipIgnorable(st)
  if (st.i >= st.lines.length) {
    st.i = save
    return null
  }
  const childIndent = indentOf(st.lines[st.i])
  if (childIndent <= indent) {
    // No hay hijo: la clave quedó vacía. `null` y no `{}` — vacío en el
    // runner.yaml significa "sin restricción", y un objeto vacío no lo dice.
    st.i = save
    return null
  }
  return parseBlock(st, childIndent)
}

function parseBlockScalar(st, indent, style) {
  const keep = style.startsWith('|')
  const chomp = style.endsWith('-')
  const raw = []
  let bodyIndent = null
  while (st.i < st.lines.length) {
    const line = st.lines[st.i]
    if (isBlank(line)) {
      raw.push('')
      st.i++
      continue
    }
    const ind = indentOf(line)
    if (ind <= indent) break
    if (bodyIndent == null) bodyIndent = ind
    raw.push(line.slice(Math.min(bodyIndent, ind)))
    st.i++
  }
  // Las líneas en blanco del final no son parte del valor: son la separación
  // con la clave siguiente.
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()

  let body
  if (keep) {
    body = raw.join('\n')
  } else {
    // Folded: las líneas contiguas se unen con espacio y una línea en blanco
    // separa párrafos, que es UN salto — no dos. Agrupar y después unir lo dice
    // directo; hacerlo acumulando línea por línea es donde se cuelan los saltos
    // de más.
    const paragraphs = raw.reduce(
      (acc, line) => {
        if (line === '') return [...acc, []]
        acc[acc.length - 1].push(line)
        return acc
      },
      [[]],
    )
    body = paragraphs
      .filter((p) => p.length > 0)
      .map((p) => p.join(' '))
      .join('\n')
  }
  return chomp ? body : `${body}\n`
}

/** `clave: resto` — devuelve las dos mitades, con la clave desquoteada. */
function splitKey(line, lineNo) {
  const trimmed = line.trim()
  const idx = keyColonIndex(trimmed)
  if (idx < 0) throw new YamlError(`Se esperaba 'clave: valor' y vino '${trimmed}'`, lineNo)
  const rawKey = trimmed.slice(0, idx).trim()
  const key = isQuoted(rawKey) ? unquote(rawKey, lineNo) : rawKey
  if (key === '') throw new YamlError('Clave vacía', lineNo)
  return { key, rest: trimmed.slice(idx + 1) }
}

/** Índice del `:` que separa clave de valor, ignorando los que van adentro de
 *  comillas (`when: "a: b"`) y el `:` de un `http://` sin espacio después. */
function keyColonIndex(s) {
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#' && i > 0 && /\s/.test(s[i - 1])) return -1
    else if (ch === ':' && (i + 1 === s.length || /\s/.test(s[i + 1]))) return i
  }
  return -1
}

function looksLikeKey(s) {
  const t = s.trim()
  if (t.startsWith('{') || t.startsWith('[')) return false
  return keyColonIndex(t) >= 0
}

const isQuoted = (s) =>
  (s.startsWith('"') && s.endsWith('"') && s.length > 1) ||
  (s.startsWith("'") && s.endsWith("'") && s.length > 1)

function unquote(s, lineNo) {
  const q = s[0]
  const body = s.slice(1, -1)
  if (q === "'") return body.replace(/''/g, "'")
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      out += body[i]
      continue
    }
    const next = body[++i]
    if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === 'r') out += '\r'
    else if (next === '\\') out += '\\'
    else if (next === '"') out += '"'
    else if (next === undefined) throw new YamlError('Escape colgando al final', lineNo)
    else out += next
  }
  return out
}

export function parseScalar(raw, lineNo) {
  const s = stripComment(raw).trim()
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null
  if (isQuoted(s)) return unquote(s, lineNo)
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false
  if (s.startsWith('[')) return parseFlowSeq(s, lineNo)
  if (s.startsWith('{')) return parseFlowMap(s, lineNo)
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10)
  if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s)
  return s
}

/** Saca el comentario final (` # ...`) sin tocar un `#` que está entre comillas
 *  ni uno pegado a texto (`status:#1` no es un comentario). */
function stripComment(s) {
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
  }
  return s
}

/** Parte por comas del nivel superior, respetando comillas y anidamiento. */
function splitFlow(body, lineNo) {
  const parts = []
  let depth = 0
  let quote = null
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      cur += ch
      if (ch === '\\' && quote === '"') cur += body[++i] ?? ''
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === '[' || ch === '{') {
      depth++
      cur += ch
    } else if (ch === ']' || ch === '}') {
      depth--
      cur += ch
    } else if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (quote) throw new YamlError('Comilla sin cerrar', lineNo)
  if (cur.trim() !== '') parts.push(cur)
  return parts
}

function parseFlowSeq(s, lineNo) {
  if (!s.endsWith(']')) throw new YamlError(`Secuencia inline sin cerrar: '${s}'`, lineNo)
  return splitFlow(s.slice(1, -1), lineNo).map((p) => parseScalar(p, lineNo))
}

function parseFlowMap(s, lineNo) {
  if (!s.endsWith('}')) throw new YamlError(`Mapa inline sin cerrar: '${s}'`, lineNo)
  const out = {}
  for (const part of splitFlow(s.slice(1, -1), lineNo)) {
    const { key, rest } = splitKey(part, lineNo)
    out[key] = parseScalar(rest, lineNo)
  }
  return out
}

// ═══ LABELS — el estado del pipeline, codificado como label ────────────────────

// El codec de estado — port directo de `StatusLabelCodec` del engine
// (packages/issue-sources/src/github-issues/status-label.ts).
//
// Un issue de GitHub no tiene campo "Status" (eso es Projects v2), así que el
// estado del pipeline se codifica como una label con prefijo. La propiedad que
// hace que todo lo demás funcione: **un solo status a la vez**. `withStatus`
// saca cualquier `status:*` antes de poner el nuevo, igual que un Single-Select
// de un Project sólo sostiene un valor.

export const DEFAULT_STATUS_PREFIX = 'status:'
export const DEFAULT_ANCHOR_LABEL = 'ia-flow'
export const DEFAULT_WORKING_LABEL = 'ia-flow:working'

export class StatusLabels {
  constructor({ prefix = DEFAULT_STATUS_PREFIX, working = DEFAULT_WORKING_LABEL } = {}) {
    // Normalizado una vez para que toda comparación de abajo sea
    // case-insensitive contra un prefijo consistente: quien configure
    // `Status:` tiene que matchear las mismas labels que el default.
    this.prefix = prefix.toLowerCase()
    this.working = working
  }

  /** '' cuando el issue no tiene label de status — el llamador lo lee como
   *  "sin status", que es lo que hace elegible al agente de entrada. */
  statusFrom(labels) {
    const match = labels.find((l) => l.toLowerCase().startsWith(this.prefix))
    return match ? match.slice(this.prefix.length) : ''
  }

  isStatusLabel(label) {
    return label.toLowerCase().startsWith(this.prefix)
  }

  labelFor(status) {
    return `${this.prefix}${status}`
  }

  withStatus(labels, newStatus) {
    const rest = labels.filter((l) => !this.isStatusLabel(l))
    return newStatus ? [...rest, this.labelFor(newStatus)] : rest
  }

  /** Los statuses que existen en un catálogo de labels del repo. Es lo que
   *  permite que `/ia-flow:scan` dibuje el board sin que nadie enumere los
   *  estados dos veces. */
  statusesIn(labels) {
    return labels.filter((l) => this.isStatusLabel(l)).map((l) => l.slice(this.prefix.length))
  }

  isWorking(labels) {
    return labels.includes(this.working)
  }

  withWorking(labels, working) {
    const without = labels.filter((l) => l !== this.working)
    return working ? [...without, this.working] : without
  }
}

/** Trackeado = tiene la label ancla. Es el opt-in: sin ella, el pipeline no
 *  toca el issue. Un repo compartido con gente que no usa esto no se llena de
 *  labels ni de comentarios de agentes por accidente. */
export function isTracked(labels, anchorLabel) {
  if (!anchorLabel) return true
  return labels.some((l) => l.toLowerCase() === anchorLabel.toLowerCase())
}

// ═══ SELECCIÓN — qué agente aplica a este issue ────────────────────────────────

// Selección de agente — los filtros del engine, puros y sin I/O.
//
// Dado un issue, la pregunta es *¿qué agente aplica acá?*. No hay tabla que
// cablee "este status corre estos agentes": cada agente declara sus criterios
// y el engine evalúa en orden. En repo/status, **vacío = sin restricción**.
//
//   0. Scope    — statusName o when: al menos uno (ver abajo, no es cosmético)
//   1. Repo     — repoName null, o coincide con el repo del issue
//   2. Status   — statusName null, o coincide (case-insensitive)
//   3. When     — las condiciones evalúan true contra los campos del issue
//
// De los habilitados que sobreviven todos, corre el PRIMERO por `position`.
// Un dispatch corre UN agente: su salida mueve el issue y el próximo scan
// vuelve a seleccionar contra el status nuevo. Así avanza el pipeline sin que
// ninguna pieza conozca la cadena entera.

/** Por qué el filtro 0 existe: sin `statusName` NI `when`, un agente no tiene
 *  ningún criterio que deje de cumplirse cuando termina su propio run —
 *  `statusName` nulo matchea cualquier status, así que la salida que mueve el
 *  issue no lo saca de la selección y el próximo ciclo lo vuelve a elegir para
 *  el MISMO issue, para siempre. */
export function hasScope(agent) {
  const a = agent.activation ?? {}
  return Boolean(a.statusName) || (Array.isArray(a.when) ? a.when.length > 0 : Boolean(a.when))
}

const lower = (v) => String(v ?? '').toLowerCase()

/** Los campos del issue contra los que se puede escribir una condición.
 *  Un alias por concepto, no uno por forma de escribirlo. */
export function issueFields(issue) {
  return {
    status: issue.status ?? '',
    labels: issue.labels ?? [],
    title: issue.title ?? '',
    body: issue.body ?? '',
    author: issue.author ?? '',
    assignee: (issue.assignees ?? []).join(','),
    assignees: issue.assignees ?? [],
    repo: issue.repo ?? '',
    number: issue.number,
    state: issue.state ?? 'open',
    hasPr: Boolean(issue.pullRequests?.length),
  }
}

const OPS = {
  '=': (actual, expected) => lower(actual) === lower(expected),
  '==': (actual, expected) => lower(actual) === lower(expected),
  '!=': (actual, expected) => lower(actual) !== lower(expected),
  contains: (actual, expected) =>
    Array.isArray(actual)
      ? actual.some((v) => lower(v) === lower(expected))
      : lower(actual).includes(lower(expected)),
  'not-contains': (actual, expected) => !OPS.contains(actual, expected),
  in: (actual, expected) =>
    String(expected)
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .includes(lower(actual)),
  'not-in': (actual, expected) => !OPS.in(actual, expected),
  matches: (actual, expected) => new RegExp(expected, 'i').test(String(actual ?? '')),
  empty: (actual) => (Array.isArray(actual) ? actual.length === 0 : String(actual ?? '') === ''),
  'not-empty': (actual) => !OPS.empty(actual),
}

export const CONDITION_OPS = Object.keys(OPS)

/**
 * Evalúa las condiciones contra los campos del issue. Ausente ⇒ true.
 *
 * Dos formas: el array (`[{ field, op, value }]`, con AND entre condiciones) y
 * el record plano (`{ status: refine }`, azúcar para todo-`=`). El record
 * existe porque el 90% de las condiciones son una igualdad y obligar a escribir
 * el objeto largo para eso hace que nadie las use.
 */
export function evalWhen(when, issue) {
  if (!when) return true
  const fields = issueFields(issue)
  const conditions = Array.isArray(when)
    ? when
    : Object.entries(when).map(([field, value]) => ({ field, op: '=', value }))

  return conditions.every((c) => {
    const op = OPS[c.op ?? '=']
    if (!op)
      throw new Error(`Operador desconocido en 'when': '${c.op}' (${CONDITION_OPS.join(', ')})`)
    return op(fields[c.field], c.value)
  })
}

/** Los candidatos que sobreviven los cuatro filtros, ya ordenados. */
export function candidates(agents, issue) {
  return agents
    .filter((a) => a.enabled !== false)
    .filter(hasScope)
    .filter((a) => {
      const act = a.activation ?? {}
      if (act.repoName && lower(act.repoName) !== lower(issue.repo)) return false
      if (act.statusName && lower(act.statusName) !== lower(issue.status)) return false
      return evalWhen(act.when, issue)
    })
    .sort((a, b) => (a.activation?.position ?? 0) - (b.activation?.position ?? 0))
}

/** El agente que corre, o null. */
export function selectAgent(agents, issue) {
  return candidates(agents, issue)[0] ?? null
}

/** Por qué NO corrió ninguno — para que `/ia-flow:scan` no diga sólo "nada
 *  matcheó". Un pipeline que se queda quieto sin explicación es indebuggeable. */
export function explainNoMatch(agents, issue) {
  const reasons = []
  for (const a of agents) {
    if (a.enabled === false) {
      reasons.push(`${a.id}: deshabilitado`)
      continue
    }
    if (!hasScope(a)) {
      reasons.push(`${a.id}: sin scope (necesita activation.statusName o activation.when)`)
      continue
    }
    const act = a.activation ?? {}
    if (act.repoName && lower(act.repoName) !== lower(issue.repo)) {
      reasons.push(`${a.id}: repo '${act.repoName}' ≠ '${issue.repo}'`)
      continue
    }
    if (act.statusName && lower(act.statusName) !== lower(issue.status)) {
      reasons.push(`${a.id}: status '${act.statusName}' ≠ '${issue.status || '(sin status)'}'`)
      continue
    }
    if (!evalWhen(act.when, issue)) reasons.push(`${a.id}: 'when' no se cumple`)
  }
  return reasons
}

// ═══ TRANSICIONES — qué le pasa al issue cuando el run termina ─────────────────

// Salidas y transiciones — qué le pasa al issue cuando un run termina.
//
// Un run termina aplicando UNA transición. `success` y `error` son nombres
// RESERVADOS: los elige el engine según cómo terminó el run. Cualquier otra
// clave es una salida que el AGENTE puede pedir por nombre — y sólo por
// nombre: nunca recibe un mapa de campos libre. El operador sigue dibujando
// todas las aristas del grafo; el agente elige entre las que ya están
// dibujadas, así que el pipeline se lee entero en el runner.yaml.

export const SUCCESS_EXIT = 'success'
export const ERROR_EXIT = 'error'
export const DEFAULT_COMMENT_TARGET = 'pr-else-issue'
export const COMMENT_TARGETS = ['issue', 'pr', 'pr-else-issue', 'none']

/** La transición de una salida, venga en forma corta (`success: build`) o
 *  larga (`success: { set: ..., when: ..., comment: ... }`). */
export function exitSet(exit) {
  if (exit == null) return undefined
  return typeof exit === 'string' ? exit : exit.set
}

/** Cuándo usarla. No es documentación: viaja al agente como la descripción de
 *  la salida, así que es lo que el modelo lee para decidir. Sin esto, ve el
 *  nombre pelado (`back-to-build`) y depende de que alguien lo haya explicado
 *  en el prompt — o sea, declarar la salida y explicarla serían dos ediciones
 *  en dos lugares, y olvidar la segunda deja config muerta. */
export function exitWhen(exit) {
  return exit == null || typeof exit === 'string' ? undefined : exit.when
}

export function exitComment(exit) {
  return exit == null || typeof exit === 'string' ? undefined : exit.comment
}

/** Destino efectivo del comentario: **salida > agente > default**. */
export function resolveCommentTarget(exit, agentDefault) {
  return exitComment(exit) ?? agentDefault ?? DEFAULT_COMMENT_TARGET
}

/** Las salidas que el agente puede PEDIR por nombre: todas menos las dos
 *  reservadas. Un agente que sólo declara `success`/`error` no puede elegir
 *  nada, y por eso ni se le ofrece el mecanismo. */
export function selectableExits(agent) {
  const exits = agent.exits ?? {}
  return Object.keys(exits)
    .filter((name) => name !== SUCCESS_EXIT && name !== ERROR_EXIT)
    .map((name) => ({ name, when: exitWhen(exits[name]), set: exitSet(exits[name]) }))
}

/**
 * Parsea el slot de una salida a los campos que hay que escribir.
 *
 * Formas aceptadas, de la más corta a la más explícita:
 *   `build`                       → status=build
 *   `status=build`                → idem
 *   `labels=+needs-qa,-wip`       → suma y resta, el resto queda
 *   `status=done; state=closed`   → varios campos, separados por `;`
 *
 * El nombre pelado existe porque mover el status ES la transición del 95% de
 * las salidas; obligar a escribir `status=` en todas sería ruido.
 */
export function parseSet(raw) {
  if (!raw || String(raw).trim() === '') return null
  const text = String(raw)
    .trim()
    .replace(/^\$set:/i, '')
  const patch = {}
  for (const part of text.split(';')) {
    const chunk = part.trim()
    if (chunk === '') continue
    const eq = chunk.indexOf('=')
    if (eq < 0) {
      patch.status = chunk
      continue
    }
    const field = chunk.slice(0, eq).trim().toLowerCase()
    const value = chunk.slice(eq + 1).trim()
    if (field === 'status') patch.status = value
    else if (field === 'labels') patch.labelOps = parseLabelOps(value)
    else if (field === 'assignee' || field === 'assignees') patch.assignees = splitList(value)
    else if (field === 'state') patch.state = value.toLowerCase()
    else
      throw new Error(
        `Campo desconocido en la transición: '${field}' (status|labels|assignee|state)`,
      )
  }
  return Object.keys(patch).length > 0 ? patch : null
}

const splitList = (v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** `+a,-b,c` → { add: ['a','c'], remove: ['b'] }. Sin signo = agregar: es lo
 *  que espera quien escribe `labels=needs-qa` sin pensar en el DSL. */
export function parseLabelOps(value) {
  const add = []
  const remove = []
  for (const item of splitList(value)) {
    if (item.startsWith('-')) remove.push(item.slice(1))
    else add.push(item.startsWith('+') ? item.slice(1) : item)
  }
  return { add, remove }
}

/**
 * El patch aplicado a las labels actuales. Devuelve la lista final, que es lo
 * que `gh issue edit` necesita: la API de labels de GitHub es un set completo,
 * no un delta, así que resolver el delta ACÁ (contra las labels frescas) es lo
 * que evita pisar una label que puso un humano mientras el run corría.
 */
export function applyPatch(currentLabels, patch, statusLabels) {
  let labels = [...currentLabels]
  if (patch.labelOps) {
    const removeLower = patch.labelOps.remove.map((l) => l.toLowerCase())
    labels = labels.filter((l) => !removeLower.includes(l.toLowerCase()))
    for (const l of patch.labelOps.add) {
      if (!labels.some((x) => x.toLowerCase() === l.toLowerCase())) labels.push(l)
    }
  }
  if (patch.status != null) labels = statusLabels.withStatus(labels, patch.status)
  return labels
}

// ═══ SALIDA DEL RUN — cómo un run declara por dónde salió ──────────────────────

// Cómo un run dice por qué salida terminó.
//
// El engine tiene una tool (`select_exit`) porque el canal de tools es lo único
// que funciona igual en sync y en async. Acá el provider es el CLI de Claude y
// lo único garantizado en las dos formas de ejecutarlo —`claude -p` headless y
// la sesión interactiva— es el TEXTO final. Así que el contrato es un bloque
// marcado en la última respuesta:
//
//   <ia-flow:exit>
//   { "exit": "needs-info", "summary": "Falta el repro del bug" }
//   </ia-flow:exit>
//
// La regla de default es la misma que la del engine: sin bloque, el resultado
// lo decide cómo terminó el proceso — código 0 ⇒ `success`, ≠0 ⇒ `error`. Un
// agente que no eligió nada no bloquea el pipeline.

const BLOCK = /<ia-flow:exit>([\s\S]*?)<\/ia-flow:exit>/gi

/**
 * Devuelve `{ exit, summary }` del ÚLTIMO bloque presente, o null.
 *
 * El último y no el primero a propósito: un agente que razona en voz alta puede
 * mostrar el formato antes de usarlo de verdad, y en ese caso lo que vale es su
 * decisión final.
 */
export function parseExitMarker(text) {
  if (!text) return null
  const matches = [...String(text).matchAll(BLOCK)]
  if (matches.length === 0) return null
  const body = matches[matches.length - 1][1].trim()
  const json = body
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim()
  try {
    const parsed = JSON.parse(json)
    if (typeof parsed === 'string') return { exit: parsed, summary: undefined }
    if (!parsed || typeof parsed.exit !== 'string') return null
    return { exit: parsed.exit, summary: parsed.summary }
  } catch {
    // Un bloque con el nombre pelado adentro (`<ia-flow:exit>build</...>`) es
    // lo que escribe un modelo que no leyó bien el formato. Aceptarlo cuesta
    // dos líneas y evita mandar a `error` un run que salió bien.
    return /^[\w:-]+$/.test(json) ? { exit: json, summary: undefined } : null
  }
}

/**
 * La salida efectiva: lo que el agente pidió, validado contra lo que el agente
 * DECLARA. Un nombre que no existe no se inventa — cae al default del run, que
 * es lo que el engine ya iba a hacer.
 */
export function resolveExit(agent, requested, ok) {
  const exits = agent.exits ?? {}
  const fallback = ok ? 'success' : 'error'
  if (!requested) return { name: fallback, reason: null }
  if (!(requested in exits)) {
    return {
      name: fallback,
      reason: `El agente pidió la salida '${requested}', que no está declarada (${Object.keys(exits).join(', ') || 'ninguna'})`,
    }
  }
  return { name: requested, reason: null }
}

// ═══ CONFIG — validación del runner.yaml ──────────────────────────────────

// Dónde se busca el archivo, en orden. El primero que exista gana.
//
// `.claude/ia-flow/` va antes que `.flow/` porque es donde el resto de la
// config de Claude Code ya vive: quien instala el plugin no tiene que aprender
// una convención nueva. El de `~` cierra el caso del roster personal que se
// quiere usar en varios repos sin copiarlo a cada uno.
export const CONFIG_CANDIDATES = ['.claude/ia-flow/runner.yaml', '.flow/runner.yaml']
export const HOME_CONFIG = '.claude/ia-flow/runner.yaml'

/** Los defaults viven acá y en ningún otro lado: repetirlos en `flow.mjs`
 *  garantiza que un día digan cosas distintas. */
export const DEFAULT_SETTINGS = {
  anchorLabel: DEFAULT_ANCHOR_LABEL,
  statusPrefix: DEFAULT_STATUS_PREFIX,
  workingLabel: DEFAULT_WORKING_LABEL,
  claudeArgs: [],
  exec: 'claude',
}

export const EXEC_MODES = ['claude', 'print']

export class ConfigError extends Error {
  constructor(problems) {
    super(`El runner.yaml tiene ${problems.length} problema(s):\n  - ${problems.join('\n  - ')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v)

/**
 * Valida el documento ya parseado y devuelve la config normalizada.
 *
 * **Todos los problemas se juntan y se reportan juntos.** Fallar en el primero
 * obliga a descubrir el archivo de a un error por corrida, que con un roster de
 * cinco agentes es cinco ediciones a ciegas.
 *
 * Y valida al CARGAR, no al despachar: un `comment: prs` mal escrito tiene que
 * romper antes de que el agente corra, no después — cuando el trabajo ya está
 * hecho y lo único que queda por decidir es dónde publicarlo.
 */
export function normalizeConfig(doc) {
  const problems = []
  if (!isPlainObject(doc)) throw new ConfigError(['El archivo no contiene un mapa YAML.'])

  if (doc.version != null && doc.version !== 1) {
    problems.push(`version: se esperaba 1 y vino '${doc.version}'`)
  }

  const settings = { ...DEFAULT_SETTINGS, ...(isPlainObject(doc.settings) ? doc.settings : {}) }
  if (doc.settings != null && !isPlainObject(doc.settings)) {
    problems.push('settings: se esperaba un mapa')
  }
  for (const key of ['anchorLabel', 'statusPrefix', 'workingLabel']) {
    if (settings[key] != null && typeof settings[key] !== 'string') {
      problems.push(`settings.${key}: se esperaba un string`)
    }
  }
  if (!EXEC_MODES.includes(settings.exec)) {
    problems.push(`settings.exec: '${settings.exec}' no es válido (${EXEC_MODES.join(' | ')})`)
  }
  if (
    !Array.isArray(settings.claudeArgs) ||
    settings.claudeArgs.some((a) => typeof a !== 'string')
  ) {
    problems.push('settings.claudeArgs: se esperaba una lista de strings')
  }

  const rawAgents = doc.agents
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    problems.push('agents: se esperaba una lista con al menos un agente')
    throw new ConfigError(problems)
  }

  const seen = new Set()
  const agents = rawAgents.map((agent, i) => normalizeAgent(agent, i, seen, problems))
  if (problems.length > 0) throw new ConfigError(problems)
  return { settings, agents }
}

function normalizeAgent(agent, i, seen, problems) {
  const where = isPlainObject(agent) && agent.id ? `agents['${agent.id}']` : `agents[${i}]`
  if (!isPlainObject(agent)) {
    problems.push(`${where}: se esperaba un mapa`)
    return { id: `#${i}` }
  }

  if (typeof agent.id !== 'string' || agent.id.trim() === '') {
    problems.push(`${where}: falta 'id'`)
  } else if (seen.has(agent.id)) {
    // El id es la clave con la que `--agent` y los logs nombran al agente; dos
    // filas con el mismo id hacen que "corrió refiner" sea ambiguo.
    problems.push(`${where}: el id '${agent.id}' está repetido`)
  } else {
    seen.add(agent.id)
  }

  if (typeof agent.prompt !== 'string' || agent.prompt.trim() === '') {
    problems.push(`${where}: falta 'prompt'`)
  }

  // El filtro 0 del engine, y la única validación acá que evita un loop en vez
  // de un error de tipeo: sin `statusName` NI `when`, la salida del agente no lo
  // saca de la selección y el próximo dispatch lo vuelve a elegir para el mismo
  // issue, sin freno.
  if (!hasScope(agent)) {
    problems.push(
      `${where}: sin scope — necesita 'activation.statusName' o 'activation.when', ` +
        'o se re-dispararía sobre el mismo issue para siempre',
    )
  }
  const activation = isPlainObject(agent.activation) ? agent.activation : {}
  if (agent.activation != null && !isPlainObject(agent.activation)) {
    problems.push(`${where}.activation: se esperaba un mapa`)
  }
  validateWhen(activation.when, `${where}.activation.when`, problems)

  if (agent.comment != null && !COMMENT_TARGETS.includes(agent.comment)) {
    problems.push(
      `${where}.comment: '${agent.comment}' no es válido (${COMMENT_TARGETS.join(' | ')})`,
    )
  }
  if (
    agent.tools != null &&
    (!Array.isArray(agent.tools) || agent.tools.some((t) => typeof t !== 'string'))
  ) {
    problems.push(`${where}.tools: se esperaba una lista de strings`)
  }

  if (agent.exits != null && !isPlainObject(agent.exits)) {
    problems.push(`${where}.exits: se esperaba un mapa`)
  } else {
    for (const [name, exit] of Object.entries(agent.exits ?? {})) {
      const set = exitSet(exit)
      if (typeof set !== 'string' || set.trim() === '') {
        problems.push(
          `${where}.exits.${name}: falta la transición ('build', o { set: 'status=build' })`,
        )
        continue
      }
      try {
        parseSet(set)
      } catch (err) {
        problems.push(`${where}.exits.${name}: ${err.message}`)
      }
      const target = exitComment(exit)
      if (target != null && !COMMENT_TARGETS.includes(target)) {
        problems.push(`${where}.exits.${name}.comment: '${target}' no es válido`)
      }
      // Una salida que el agente puede pedir por nombre y no explica qué
      // significa es el modo de falla que ya tuvo `whenText`: declarada, y sin
      // nada que le diga al modelo cuándo usarla. Warn y no error — el pipeline
      // funciona igual, sólo elige peor.
      if (name !== SUCCESS_EXIT && name !== ERROR_EXIT && !exitWhen(exit)) {
        problems.push(
          `${where}.exits.${name}: es una salida elegible sin 'when' — sin él el agente ` +
            'sólo ve el nombre pelado y no sabe cuándo pedirla',
        )
      }
    }
  }

  return agent
}

function validateWhen(when, where, problems) {
  if (when == null) return
  if (isPlainObject(when)) return // el record plano es todo-igualdad, no hay nada que validar
  if (!Array.isArray(when)) {
    problems.push(`${where}: se esperaba una lista de condiciones o un mapa`)
    return
  }
  for (const [i, c] of when.entries()) {
    if (!isPlainObject(c)) {
      problems.push(`${where}[${i}]: se esperaba un mapa { field, op, value }`)
      continue
    }
    if (typeof c.field !== 'string' || c.field === '')
      problems.push(`${where}[${i}]: falta 'field'`)
    if (c.op != null && !CONDITION_OPS.includes(c.op)) {
      problems.push(`${where}[${i}]: operador '${c.op}' desconocido (${CONDITION_OPS.join(', ')})`)
    }
  }
}

// ═══ RENDER — las variables del prompt de un agente ────────────────────────

/** El marker que distingue lo que escribió el pipeline del feedback humano.
 *  Sin él, el comentario de un agente y el de una persona son indistinguibles
 *  y nada puede razonar sobre la conversación después. */
export const SYSTEM_COMMENT_MARKER = '<!-- ia-flow:cli -->'

/** El comentario de cierre de un run. El header `# <agentId>` es lo que hace
 *  legible un issue con varios agentes encima. */
export function buildComment(agentId, body) {
  return `${SYSTEM_COMMENT_MARKER}\n# ${agentId}\n\n${String(body ?? '').trim()}`
}

/** Los comentarios rendidos con su procedencia, como `{{task.comments}}`. */
export function formatComments(comments) {
  if (!comments || comments.length === 0) return '(sin comentarios)'
  return comments
    .map((c) => {
      const when = c.createdAt ? String(c.createdAt).slice(0, 10) : '?'
      return `[${when} · ${c.author || '?'}]\n${String(c.body ?? '').trim()}`
    })
    .join('\n\n')
}

/**
 * Las salidas que el agente puede PEDIR, con su `when`, listas para el prompt.
 *
 * Un agente que sólo declara `success`/`error` recibe cadena vacía: no puede
 * elegir nada, así que ofrecerle el mecanismo sería enseñarle una decisión que
 * no existe.
 */
export function exitsBlock(agent) {
  const selectable = selectableExits(agent)
  if (selectable.length === 0) return ''
  const rows = selectable.map((e) => `- \`${e.name}\` — ${e.when}`).join('\n')
  return [
    'Podés terminar por una de estas salidas, si tu hallazgo lo amerita:',
    rows,
    '',
    'Para pedirla, cerrá tu último mensaje con exactamente este bloque:',
    '',
    '<ia-flow:exit>',
    '{ "exit": "<nombre>", "summary": "<una línea de por qué>" }',
    '</ia-flow:exit>',
    '',
    'Sin bloque, el run se cierra por su resultado normal.',
  ].join('\n')
}

/** El contexto contra el que se resuelven las variables del prompt. */
export function buildContext({ issue, agent, repo }) {
  return {
    task: {
      number: issue.number,
      title: issue.title ?? '',
      body: issue.body ?? '',
      status: issue.status ?? '',
      url: issue.url ?? '',
      author: issue.author ?? '',
      labels: (issue.labels ?? []).join(', '),
      comments: formatComments(issue.comments),
    },
    repo: {
      name: repo?.name ?? '',
      owner: repo?.owner ?? '',
      nameWithOwner: repo?.nameWithOwner ?? '',
    },
    agent: { id: agent?.id ?? '' },
    exits: exitsBlock(agent ?? {}),
  }
}

const VARIABLE = /\{\{\s*([\w.]+)\s*\}\}/g

/**
 * Reemplaza `{{ruta.al.valor}}` contra el contexto.
 *
 * **Una ruta desconocida queda literal**, igual que en el engine. Es
 * deliberado: un prompt que documenta su propio formato (`usá {{foo}}`) no
 * tiene por qué romperse, y un typo visible en el prompt del agente se
 * diagnostica solo — mientras que reemplazarlo por vacío lo esconde justo
 * donde más cuesta encontrarlo.
 */
export function renderTemplate(text, ctx) {
  return String(text ?? '').replace(VARIABLE, (literal, path) => {
    const value = path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), ctx)
    return value == null ? literal : String(value)
  })
}
