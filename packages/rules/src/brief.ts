// Renderiza el `brief` de una acción `agent` contra el evento que la disparó.
//
// Vive acá y no en `agent-engine` porque el sujeto es el EVENTO, que es de
// este paquete: para cuando el brief llega al engine ya es texto resuelto, y
// el engine no tiene que aprender nada sobre eventos para anteponerlo al
// prompt. Es la misma división que ya hacen `evalWhen` y `matchScope` — la
// pregunta sobre el evento se contesta acá, y lo que baja es el resultado.
//
// Deliberadamente NO reusa `resolveVariables` de `agent-engine`: aquél
// resuelve el catálogo de variables del daemon (`{{task.*}}`, `{{project.*}}`,
// `{{variables.*}}`, que necesitan estado vivo) y correría en la capa
// equivocada. Acá el vocabulario es uno solo y cerrado: `{{event.*}}`.
import type { EngineEvent } from '@ia-flow/shared'

/**
 * Reemplaza `{{event.<path>}}` por su valor en el evento.
 *
 * Alcanza `type`, `id` y cualquier camino anidado bajo `payload` o `scope`
 * (`{{event.payload.pr.number}}`). Una ruta desconocida se deja **literal**,
 * igual que hace `resolveVariables` con una variable que no existe: un brief
 * con un typo tiene que ser legible en el log del run como el typo que es, y
 * no convertirse en un hueco vacío que nadie puede diagnosticar.
 *
 * Los valores no-string se serializan; un objeto o un array salen como JSON,
 * que es más útil que `[object Object]` cuando alguien apuntó un nivel más
 * arriba del que quería.
 */
export function renderBrief(brief: string, event: EngineEvent): string {
  return brief.replace(/\{\{\s*event\.([^}\s]+)\s*\}\}/g, (match, path: string) => {
    const value = resolveEventPath(event, path)
    if (value == null) return match
    return typeof value === 'string' ? value : stringify(value)
  })
}

function resolveEventPath(event: EngineEvent, path: string): unknown {
  const segments = path.split('.')
  // `type` e `id` son campos del evento; todo lo demás cuelga de él por el
  // mismo camino (`payload.x`, `scope.projectId`), así que una sola bajada
  // genérica cubre los tres casos sin enumerar prefijos.
  let current: unknown = event
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function stringify(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    // Un payload con un ciclo (nada lo impide: el `item` de un evento es un
    // objeto vivo) no puede tumbar el dispatch por un brief.
    return String(value)
  }
}
