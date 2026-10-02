// Plantillas `{{path}}` puras: se resuelven contra un objeto, sin saber de dónde sale.
const WHOLE = /^\{\{\s*([\w.-]+)\s*\}\}$/
const EMBEDDED = /\{\{\s*([\w.-]+)\s*\}\}/g

function getPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, root)
}

/**
 * Los `{{path}}` de un valor del YAML, resueltos contra `root`. Un string que es SÓLO `{{x}}`
 * devuelve el valor tal cual (un objeto, un número, `undefined` si no existe); embebido en texto,
 * se vuelve texto (`''` si no existe). Objetos y listas se recorren.
 */
export function render(value: unknown, root: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value)
    if (whole) return getPath(root, whole[1] as string)
    return renderText(value, root)
  }
  if (Array.isArray(value)) return value.map((entry) => render(entry, root))
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, render(entry, root)]),
    )
  }
  return value
}

/** Un texto con sus `{{...}}` resueltos; `encode` se aplica a cada valor que se inserta (ej.
 *  `encodeURIComponent` en un path, para que un valor no agregue segmentos ni una query). */
export function renderText(
  text: string,
  root: Record<string, unknown>,
  encode: (value: string) => string = (value) => value,
): string {
  return text.replace(EMBEDDED, (_, path: string) => encode(asText(getPath(root, path))))
}

/** Si `value` tiene algún `{{...}}` que resolver al correr. */
export function hasTemplate(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{')
  if (Array.isArray(value)) return value.some(hasTemplate)
  if (isPlainObject(value)) return Object.values(value).some(hasTemplate)
  return false
}

/**
 * `{{vars.x}}` sustituido en TODO el documento al cargarlo — también en un `when`, que no se
 * resuelve al correr. El resto de las plantillas queda para el paso que las corre. Una var que
 * no existe rompe la carga: un typo no llega a producción.
 */
export function substituteVars<T>(doc: T, vars: Record<string, unknown>, where: string): T {
  const lookup = (path: string) => {
    const found = getPath(vars, path)
    if (found === undefined) {
      const available = Object.keys(vars)
      throw new Error(
        `${where}: no hay una var "${path}"${available.length > 0 ? ` — hay: ${available.join(', ')}` : ' (la fuente no declara ninguna)'}`,
      )
    }
    return found
  }
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = WHOLE.exec(value)
      if (whole?.[1]?.startsWith('vars.')) return lookup(whole[1].slice('vars.'.length))
      return value.replace(EMBEDDED, (match, path: string) =>
        path.startsWith('vars.') ? asText(lookup(path.slice('vars.'.length))) : match,
      )
    }
    if (Array.isArray(value)) return value.map(walk)
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]))
    }
    return value
  }
  return walk(doc) as T
}

function asText(value: unknown): string {
  if (value == null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
