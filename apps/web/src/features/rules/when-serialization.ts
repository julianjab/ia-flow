import type { ConditionRow } from '@/ui/condition-rows'
import type { WhenCondition } from '@ia-flow/shared'

// Convierte entre `WhenCondition[]` (lo que persiste, `packages/shared`) y
// `ConditionRow[]` (lo que edita `ui/ConditionRowsEditor`) — la misma
// conversión que antes vivía sólo dentro de `RuleEditorModal.vue`, ahora
// compartida con `ActionWhenEditor.vue`: dos consumidores DENTRO de esta
// feature, no cruza a `features/agents/` (que tiene su propia versión en
// `outcomes-serialization.ts` porque además resuelve el catálogo de campos
// del proyecto, algo que ni el `when` de regla ni el de acción necesitan).

// El parámetro acepta también la forma legacy (`Record<string, string>`, la
// otra mitad de `RuleSchema.when`/`RuleActionEntrySchema.when`): no la
// convierte a filas —nadie escribe esa forma desde el editor—, sólo evita que
// `Array.isArray` explote de tipos contra el union completo del schema.
export function whenToRows(
  when: WhenCondition[] | Record<string, string> | undefined | null,
): ConditionRow[] {
  const conds = Array.isArray(when) ? when : []
  return conds.map((c, i) => ({
    field: c.field,
    op: c.op,
    value: c.value ?? '',
    logic: i === 0 ? 'and' : (c.logic ?? 'and'),
  }))
}

export function rowsToWhen(rows: ConditionRow[]): WhenCondition[] | undefined {
  const when: WhenCondition[] = rows
    .filter((r) => r.field.trim())
    .map((r, i) => {
      const cond: WhenCondition = { field: r.field.trim(), op: r.op }
      if (r.op !== '$null' && r.op !== '$not_null') cond.value = r.value.trim()
      if (i > 0) cond.logic = r.logic ?? 'and'
      return cond
    })
  return when.length ? when : undefined
}
