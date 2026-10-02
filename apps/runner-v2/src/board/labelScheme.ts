/**
 * Cómo se guarda el estado de una card en los labels de un issue (el board `kind: issues`). Es la
 * traducción entre dos vocabularios y nada más — pura, sin GitHub:
 *
 *   Status = Build            ⇄  `status:build`
 *   Task Type = Functional    ⇄  `task-type:functional`   (cualquier otro campo: `<campo>:<valor>`)
 *   Working = Yes             ⇄  `working:yes`
 *
 * Un campo "vive" en todos los labels que empiezan con su prefijo; poner un valor es dejar uno solo.
 */

export interface LabelScheme {
  /** El prefijo de los labels de Status (`status:`). */
  prefix: string
  /** Las columnas, en orden de avance. Vacío: cualquier `<prefix>…` es un Status. */
  statuses: string[]
}

export const DEFAULT_STATUS_PREFIX = 'status:'

const slug = (text: string) => text.trim().toLowerCase().replace(/\s+/g, '-')
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const startsWith = (label: string, prefix: string) =>
  label.toLowerCase().startsWith(prefix.toLowerCase())

export const isStatusField = (field: string) => field.trim().toLowerCase() === 'status'

/** `Status: Build` → `status:build`; las columnas declaradas fijan cómo se escribe el valor. */
export function statusLabel(status: string, scheme: LabelScheme): string {
  const declared = scheme.statuses.find((candidate) => same(candidate, status))
  return `${scheme.prefix}${slug(declared ?? status)}`
}

/** La columna que dice un label, o `undefined` si no es uno de Status (o no es una columna declarada). */
export function statusOfLabel(label: string, scheme: LabelScheme): string | undefined {
  if (!startsWith(label, scheme.prefix)) return undefined
  const rest = label.slice(scheme.prefix.length).trim()
  if (!rest) return undefined
  if (scheme.statuses.length === 0) return rest.charAt(0).toUpperCase() + rest.slice(1)
  return scheme.statuses.find((candidate) => slug(candidate) === slug(rest))
}

/** El Status de una lista de labels. Con varios (un cambio a medias), el más avanzado de las
 *  columnas declaradas; sin columnas declaradas, el último. */
export function statusOfLabels(labels: string[], scheme: LabelScheme): string | undefined {
  const found = labels.flatMap((label) => statusOfLabel(label, scheme) ?? [])
  if (found.length <= 1 || scheme.statuses.length === 0) return found.at(-1)
  const rank = (status: string) => scheme.statuses.findIndex((candidate) => same(candidate, status))
  return found.reduce((best, status) => (rank(status) > rank(best) ? status : best))
}

/** El prefijo con el que viven los labels de un campo. */
export function fieldPrefix(field: string, scheme: LabelScheme): string {
  return isStatusField(field) ? scheme.prefix : `${slug(field)}:`
}

/** El label de un campo con un valor. */
export function fieldLabel(field: string, value: string, scheme: LabelScheme): string {
  return isStatusField(field)
    ? statusLabel(value, scheme)
    : `${fieldPrefix(field, scheme)}${slug(value)}`
}

/** El valor de un campo (en minúsculas, como lo escribe el label), o `undefined` si no está puesto. */
export function valueOfField(
  labels: string[],
  field: string,
  scheme: LabelScheme,
): string | undefined {
  const prefix = fieldPrefix(field, scheme)
  const label = labels.find((candidate) => startsWith(candidate, prefix))
  return label?.slice(prefix.length).trim() || undefined
}

/** Los labels que ocupa un campo (para sacarlos todos). */
export function labelsOfField(labels: string[], field: string, scheme: LabelScheme): string[] {
  const prefix = fieldPrefix(field, scheme)
  return labels.filter((label) => startsWith(label, prefix))
}
