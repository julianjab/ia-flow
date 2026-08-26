import { type WorkingMarker, WorkingMarkerSchema } from '@ia-flow/shared'
import { isMultiValueField } from '../dispatch/field-ops.js'

// Cómo este source anota en el board que un agente ya tomó un item, y cómo
// lee esa anotación de vuelta. Las cuatro operaciones del marker (escribir al
// arrancar, borrar al terminar, leer en cada scan, limpiar en crash-recovery)
// salen de esta única declaración — que es la razón de que sea un dato y no
// un hook: un `onProcess` cubre sólo la primera.
//
// Puro y sin I/O: `isMarkedWorking` es lo que decide si el dispatcher suelta
// un item, así que tiene que poder testearse sin red.

/** Lo que ia-flow asumió siempre antes de que esto fuera configurable: un
 *  single-select `Working` con la opción `Yes`, y "libre" = campo vacío. */
export const DEFAULT_WORKING_MARKER: WorkingMarker = { field: 'Working', on: 'Yes', off: '' }

/**
 * Resuelve `source.config.workingMarker`.
 *
 *   · ausente → DEFAULT_WORKING_MARKER (compatibilidad: los boards que ya
 *     tienen el campo `Working` siguen funcionando sin tocar nada)
 *   · null    → sin marca. El board no necesita NINGÚN campo, y el daemon
 *     queda apoyado sólo en sus guards en memoria (ver el CLAUDE.md).
 *
 * Valida en el borde (lo llama el builder del SourceFactory), así que un
 * marker mal escrito falla al guardar el proyecto o al bootear el runner —
 * no en el primer dispatch.
 */
export function parseWorkingMarker(raw: unknown): WorkingMarker | null {
  if (raw === undefined) return DEFAULT_WORKING_MARKER
  if (raw === null) return null

  const parsed = WorkingMarkerSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `workingMarker inválido: se espera { field, on, off? } — ${parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ')}`,
    )
  }
  const marker = parsed.data

  // `Status` ya lo escribe `applyTransition` en cada outcome: usarlo también
  // como marca haría que mover el issue borre la marca (o al revés) sin que
  // nadie pueda explicar cuál de los dos ganó.
  if (marker.field.toLowerCase() === 'status') {
    throw new Error("workingMarker.field no puede ser 'Status' — usá un campo propio o `Labels`")
  }

  if (isMultiValueField(marker.field)) {
    // En un campo multi-valor no hay "vaciar": el valor son operaciones con
    // signo sobre las labels vigentes, así que sacar la marca es un `-token`
    // explícito. Un `off` vacío dejaría la label puesta para siempre y todo
    // scan posterior saltearía el issue.
    if (!marker.off.trim()) {
      throw new Error(
        `workingMarker.off es obligatorio con field='${marker.field}' — poné el token que quita la marca (ej. '-ia-flow:working')`,
      )
    }
    return { ...marker, on: signed(marker.on, '+'), off: signed(marker.off, '-') }
  }

  return marker
}

/** ¿El item lleva la marca puesta? Es el gate que hace que un segundo daemon
 *  (o el scan que sigue a un reinicio) suelte un item ya tomado. */
export function isMarkedWorking(
  marker: WorkingMarker | null,
  item: { fields?: Record<string, string>; labels?: readonly string[] },
): boolean {
  if (!marker) return false
  const on = marker.on.trim().toLowerCase()
  if (!on) return false

  if (isMultiValueField(marker.field)) {
    const wanted = unsigned(on)
    return (item.labels ?? []).some((l) => l.trim().toLowerCase() === wanted)
  }

  // Case-insensitive igual que `setFields`: el nombre del campo lo escribe un
  // humano en la config y el que vuelve de GitHub es el del board.
  const entry = Object.entries(item.fields ?? {}).find(
    ([name]) => name.toLowerCase() === marker.field.toLowerCase(),
  )
  return (entry?.[1] ?? '').trim().toLowerCase() === on
}

function signed(token: string, sign: '+' | '-'): string {
  const t = token.trim()
  return /^[+\-=]/.test(t) ? t : `${sign}${t}`
}

function unsigned(token: string): string {
  return token.trim().replace(/^[+\-=]/, '')
}
