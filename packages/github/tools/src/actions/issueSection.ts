/**
 * Bloques con dueño dentro del body de un issue. Cada bloque va entre dos marcadores HTML
 * (invisibles en GitHub):
 *
 *   <!-- ia-flow:prd -->
 *   ## 🎯 Objetivo
 *   …
 *   <!-- /ia-flow:prd -->
 *
 * Lo que está fuera de los marcadores —la descripción que escribió un humano, el bloque de otro
 * agente— no se toca nunca. Un bloque puede contener otros (`prd.zona_de_impacto` dentro de
 * `prd`): los ids son distintos, así que cada uno se encuentra por separado.
 */

const SECTION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

function assertSectionId(id: string): string {
  if (!SECTION_ID.test(id)) throw new Error(`issueSection: id de bloque inválido: "${id}"`)
  return id
}

export function sectionMarkers(id: string): { open: string; close: string } {
  assertSectionId(id)
  return { open: `<!-- ia-flow:${id} -->`, close: `<!-- /ia-flow:${id} -->` }
}

/** `markdown` envuelto en los marcadores del bloque `id`. */
export function wrapSection(id: string, markdown: string): string {
  const { open, close } = sectionMarkers(id)
  return `${open}\n${markdown.trim()}\n${close}`
}

function locate(body: string, id: string) {
  const { open, close } = sectionMarkers(id)
  const start = body.indexOf(open)
  if (start === -1) return undefined
  const end = body.indexOf(close, start + open.length)
  if (end === -1) {
    throw new Error(`issueSection: el bloque "${id}" abre pero no cierra — editado a mano?`)
  }
  return { start, end: end + close.length, contentStart: start + open.length, contentEnd: end }
}

/** El contenido del bloque `id` (sin los marcadores), o `undefined` si el body no lo tiene. */
export function readSection(body: string, id: string): string | undefined {
  const at = locate(body, id)
  return at ? body.slice(at.contentStart, at.contentEnd).trim() : undefined
}

/** El body con el bloque `id` reemplazado por `markdown`. Si no existía, se agrega al final. */
export function writeSection(body: string, id: string, markdown: string): string {
  const block = wrapSection(id, markdown)
  const at = locate(body, id)
  if (at) return `${body.slice(0, at.start)}${block}${body.slice(at.end)}`
  const head = body.trimEnd()
  return head ? `${head}\n\n${block}\n` : `${block}\n`
}

const CHECKBOX = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$/

export interface ChecklistItem {
  /** 1-based, en el orden en que aparece en el bloque. */
  index: number
  checked: boolean
  text: string
}

/** Los ítems `- [ ]` / `- [x]` del bloque, numerados desde 1. */
export function listChecklist(markdown: string): ChecklistItem[] {
  const items: ChecklistItem[] = []
  for (const line of markdown.split('\n')) {
    const match = line.match(CHECKBOX)
    if (match) {
      items.push({ index: items.length + 1, checked: match[2] !== ' ', text: match[4] as string })
    }
  }
  return items
}

/**
 * Tilda (o destilda) los ítems `indices` (1-based) del checklist que vive en el bloque `id`.
 * Sólo cambia el carácter entre corchetes: el texto de cada ítem queda idéntico.
 */
export function setChecked(
  body: string,
  id: string,
  indices: readonly number[],
  checked: boolean,
): { body: string; items: ChecklistItem[] } {
  const at = locate(body, id)
  if (!at) throw new Error(`issueSection: el body no tiene el bloque "${id}"`)
  const content = body.slice(at.contentStart, at.contentEnd)
  const total = listChecklist(content).length
  const wanted = new Set(indices)
  const outOfRange = [...wanted].filter((i) => !Number.isInteger(i) || i < 1 || i > total)
  if (outOfRange.length > 0) {
    throw new Error(
      `issueSection: el bloque "${id}" tiene ${total} ítems — no existen: ${outOfRange.join(', ')}`,
    )
  }

  let seen = 0
  const updated = content
    .split('\n')
    .map((line) => {
      const match = line.match(CHECKBOX)
      if (!match) return line
      seen++
      return wanted.has(seen) ? `${match[1]}${checked ? 'x' : ' '}${match[3]}${match[4]}` : line
    })
    .join('\n')
  return {
    body: `${body.slice(0, at.contentStart)}${updated}${body.slice(at.contentEnd)}`,
    items: listChecklist(updated),
  }
}

/**
 * `next` con las casillas que ya estaban tildadas en `previous` para el mismo texto de ítem. Así
 * reescribir un bloque entero (el refiner corrigiendo el PRD) no borra el progreso que otro agente
 * ya marcó. Un ítem cuyo texto cambió cuenta como trabajo nuevo y queda sin tildar.
 */
export function carryChecks(previous: string, next: string): string {
  const done = new Set(
    listChecklist(previous)
      .filter((item) => item.checked)
      .map((item) => item.text),
  )
  if (done.size === 0) return next
  return next
    .split('\n')
    .map((line) => {
      const match = line.match(CHECKBOX)
      return match && match[2] === ' ' && done.has(match[4] as string)
        ? `${match[1]}x${match[3]}${match[4]}`
        : line
    })
    .join('\n')
}
