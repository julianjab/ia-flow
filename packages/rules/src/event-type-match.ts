// El matcher de `on` — compartido por `match.ts` (reglas) y `waits.ts`
// (esperas): las dos son "¿este entry de `on` describe este evento?", y
// separarlo evita que las dos reimplementen la misma regla con un sutil
// desvío entre ellas.
import type { EngineEvent } from '@ia-flow/shared'

/**
 * Un entry de `on` matchea de dos formas, en este orden:
 *
 *  1. **Literal**: `entry === event.type`. Cubre el caso de siempre, INCLUIDOS
 *     los tipos sintéticos que ya traen un punto en su nombre propio
 *     (`issue.status_changed`, `wait.resumed`, …) — para esos el match
 *     literal gana antes de intentar separarlos, así que nunca se
 *     malinterpreta `issue` como tipo y `status_changed` como action.
 *
 *  2. **`tipo.action`**: sólo si el literal no matcheó Y el entry tiene un
 *     punto. Se separa en `tipo` (antes del primer punto) + `action` (el
 *     resto), y exige `event.type === tipo` Y `event.payload.action ===
 *     action`. Es azúcar sobre un `when: {field: action, op: '=', value:
 *     action}` — evita escribirlo a mano para el caso más común (un solo
 *     valor de `action`), y sobre todo permite MEZCLAR en un mismo `on` un
 *     tipo con action (`projects_v2_item.edited`) junto a tipos sin action
 *     (`issue.created`, `issue.status_changed`) sin que un `when`
 *     compartido —que se evalúa contra TODO el `on`, no por entry— tenga
 *     que filtrar por un campo que el segundo tipo nunca trae. Antes de
 *     esto, esa mezcla no se podía expresar en una sola regla (o espera):
 *     había que partirla en dos, duplicando el `do:`/lo que sea que dispare.
 */
function matchesOnEntry(entry: string, event: EngineEvent): boolean {
  if (entry === event.type) return true
  const dot = entry.indexOf('.')
  if (dot === -1) return false
  const type = entry.slice(0, dot)
  const action = entry.slice(dot + 1)
  if (!action || type !== event.type) return false
  return event.payload.action === action
}

/** ¿Alguno de los entries de `on` describe este evento? */
export function onMatchesEvent(on: readonly string[], event: EngineEvent): boolean {
  return on.some((entry) => matchesOnEntry(entry, event))
}
