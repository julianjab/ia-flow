import { isMultiValueField } from '../dispatch/field-ops.js'

// En qué campo del board guarda este source el link del hilo de Slack de una
// tarea, y cómo lo lee de vuelta. Mismo patrón —y mismos motivos— que
// `working-marker.ts`: es un dato declarado en `source.config`, no un hook, así
// que las dos operaciones (escribir al pedir el review, leer para decidir si el
// próximo pedido es un re-review) salen de la misma declaración.
//
// Puro y sin I/O.

export const DEFAULT_SLACK_THREAD_FIELD = 'SlackThread'

/**
 * Resuelve `source.config.slackThreadField`.
 *
 *   · ausente → `SlackThread`. El board que ya tiene ese campo custom funciona
 *     sin tocar nada.
 *   · null    → el board no guarda el link. La fuente cae al cuerpo del PR
 *     (sección `## Slack`), que no necesita ninguna config previa.
 *
 * Valida en el borde (lo llama el builder del SourceFactory), así que un nombre
 * mal escrito falla al guardar el proyecto y no en el primer pedido de review.
 */
export function parseSlackThreadField(raw: unknown): string | null {
  if (raw === undefined) return DEFAULT_SLACK_THREAD_FIELD
  if (raw === null) return null

  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('slackThreadField inválido: se espera el nombre de un campo, o null')
  }
  const field = raw.trim()

  // `Status` lo escribe `applyTransition` en cada outcome, y un multi-valor
  // (Labels) no tiene "un valor" que reemplazar — guardar ahí una URL la
  // convertiría en una label suelta que nadie puede leer de vuelta.
  if (field.toLowerCase() === 'status') {
    throw new Error("slackThreadField no puede ser 'Status' — usá un campo de texto propio")
  }
  if (isMultiValueField(field)) {
    throw new Error(
      `slackThreadField no puede ser '${field}': es multi-valor y el link necesita un campo de texto`,
    )
  }
  return field
}

/** Lookup case-insensitive, igual que `isMarkedWorking`: el nombre del campo lo
 *  escribe un humano en la config y el que vuelve de GitHub es el del board. */
export function readSlackThreadField(
  field: string | null,
  fields: Record<string, string> | undefined,
): string | undefined {
  if (!field) return undefined
  const entry = Object.entries(fields ?? {}).find(
    ([name]) => name.toLowerCase() === field.toLowerCase(),
  )
  const value = entry?.[1]?.trim()
  return value || undefined
}
