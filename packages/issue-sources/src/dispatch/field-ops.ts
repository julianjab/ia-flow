// Operaciones sobre un campo MULTI-VALOR de un source (hoy: `Labels`).
//
// Un campo de un solo valor se asigna: `Priority=high` reemplaza lo que
// hubiera. Uno multi-valor no puede funcionar así — el agente casi nunca
// quiere "las labels del issue son exactamente éstas", quiere "agregá ésta,
// sacá aquélla" sin pisar lo que pusieron otros (ni el bookkeeping del
// propio source). De ahí los tokens con signo.
//
// Vive acá, y no en agent-engine, porque los tres task-sources lo necesitan
// para resolver un `setFields` contra un campo multi-valor, y agent-engine
// ya depende de este paquete (no al revés). Es la misma semántica que tenía
// el DSL `$labels:` antes de unificarse en `$set:`.

/**
 * Aplica los tokens con signo sobre el valor actual del campo. Puro.
 *
 * Gramática: `+añadir,-quitar,=reemplazar` (mezclables y repetibles).
 *
 *   · Si hay al menos un token `=`, la base es exactamente ese conjunto — es
 *     la fila "Reemplazar por" del editor, que define el set completo. Un `=`
 *     pelado vacía el campo.
 *   · Si no, la base es el valor actual.
 *   · Sobre esa base se aplican los `+` y después los `-`, de modo que quitar
 *     gana sobre añadir si alguien declara ambos para el mismo valor.
 *
 * Un token sin prefijo se trata como `+`: es el error de tipeo más probable y
 * "añadir" es la interpretación segura (no destruye lo que ya estaba).
 */
interface ParsedTokens {
  replace: string[]
  // Separado de `replace.length` a propósito: un `=` pelado significa
  // "reemplazar por nada" (vaciar), que es distinto de no traer ningún token
  // `=`. Sin esta bandera, vaciar el campo sería inexpresable.
  hasReplace: boolean
  add: string[]
  remove: Set<string>
}

/** Clasifica UN token con signo en el balde que le corresponde. */
function applyToken(sink: ParsedTokens, token: string): void {
  const prefix = token[0]
  const name = token.slice(1).trim()
  if (prefix === '=') {
    sink.hasReplace = true
    if (name) sink.replace.push(name)
    return
  }
  if (prefix === '-') {
    if (name) sink.remove.add(name)
    return
  }
  if (prefix === '+') {
    if (name) sink.add.push(name)
    return
  }
  sink.add.push(token)
}

/** Clasifica cada token con signo en su balde (`=`/`-`/`+`/sin prefijo). */
function parseMultiValueTokens(tokens: string[]): ParsedTokens {
  const sink: ParsedTokens = { replace: [], hasReplace: false, add: [], remove: new Set() }
  for (const token of tokens) applyToken(sink, token)
  return sink
}

export function applyMultiValueOps(current: string[], spec: string): string[] {
  const tokens = spec
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  const { replace, hasReplace, add, remove } = parseMultiValueTokens(tokens)

  const base = hasReplace ? replace : current
  const result: string[] = []
  for (const value of [...base, ...add]) {
    if (!remove.has(value) && !result.includes(value)) result.push(value)
  }
  return result
}

/** Nombre del único campo multi-valor que los sources saben escribir hoy.
 *  `Assignees` es multi-valor conceptualmente pero ningún source expone una
 *  primitiva de escritura para él, así que no entra acá hasta que exista. */
export const MULTI_VALUE_FIELD = 'Labels'

/** Case-insensitive: el nombre del campo viaja tal como el usuario lo
 *  escribió en el editor de outcomes o en el YAML del roster. */
export function isMultiValueField(field: string): boolean {
  return field.trim().toLowerCase() === MULTI_VALUE_FIELD.toLowerCase()
}

// Re-exportado desde @ia-flow/shared: el valor cruza el wire hasta el editor
// de outcomes, así que su definición vive en el paquete de contrato. Acá se
// re-exporta para que los sources lo importen junto al resto de las piezas
// de campo multi-valor.
export { MULTI_SELECT_DATA_TYPE } from '@ia-flow/shared'
