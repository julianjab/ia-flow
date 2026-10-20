import { z } from 'zod'

/** El `<parameter name="x">` de la sintaxis de tool use que a veces se filtra dentro de un
 *  string, con su cierre opcional. */
const LEAKED_PARAMETER = /^\s*<parameter name="([A-Za-z_][\w-]*)">([\s\S]*?)(?:<\/parameter>\s*)?$/

/**
 * Un campo que el schema declara como objeto y el modelo mandó como string, reparado: el string
 * es el objeto serializado (`"{\"text\": …}"`), o trae el `<parameter name="x">` de la sintaxis
 * de tool use filtrado (`"\n<parameter name=\"text\">…"`). Pasa sobre todo con un objeto
 * anidado que lleva texto largo (`submit_done.result.text`); el modelo se corrige al reintentar,
 * pero cada vuelta cuesta un request entero.
 *
 * Sólo mira los campos de primer nivel cuyo schema es un objeto. Devuelve `undefined` si no
 * había nada que reparar; quien la llama vuelve a validar lo que devuelve.
 */
export function repairNestedObjects(
  schema: z.ZodObject,
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined
  let repaired: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const field = objectSchema(schema.shape[key])
    if (!field) continue
    const object = parseObject(value, field)
    if (object) repaired = { ...(repaired ?? raw), [key]: object }
  }
  return repaired
}

function parseObject(value: string, field: z.ZodObject): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (isRecord(parsed)) return parsed
  } catch {
    // No es JSON: puede ser el parámetro filtrado.
  }
  const leaked = LEAKED_PARAMETER.exec(value)
  if (!leaked) return undefined
  const [, name, body] = leaked as unknown as [string, string, string]
  return name in field.shape ? { [name]: body.trimEnd() } : undefined
}

/** El objeto detrás de un campo (también `optional`/`nullable`), o `undefined` si no es uno. */
function objectSchema(field: unknown): z.ZodObject | undefined {
  let current = field
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current.unwrap()
  }
  return current instanceof z.ZodObject ? current : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
