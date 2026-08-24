import type { VariableGroup } from '@/features/prompts/PromptField.vue'
import { apiBase } from '@/features/servers/selection'
import type { VariableDefinition } from '@ia-flow/shared'
// Carga y agrupa las variables de template disponibles para un prompt de
// agente, en la forma que espera `PromptField` (grupos con items + hints).
//
// Vive en composables/ y no dentro de features/agents/ porque es lógica
// reactiva transversal: cualquier editor que monte un PromptField necesita
// exactamente esto, y no depende de nada del dominio de agentes.
import { type Ref, onMounted, ref } from 'vue'

const API_BASE = apiBase()

// Orden de presentación: de lo más específico del proyecto a lo más genérico,
// que es el orden en que un autor de prompts los busca.
const GROUP_ORDER = ['project', 'task', 'context', 'github', 'custom', 'system']

function toGroups(defs: VariableDefinition[]): VariableGroup[] {
  const byGroup = new Map<string, VariableDefinition[]>()
  for (const v of defs) {
    if (!byGroup.has(v.group)) byGroup.set(v.group, [])
    byGroup.get(v.group)!.push(v)
  }
  return [...byGroup.entries()]
    .sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]))
    .map(([label, items]) => ({
      label,
      items: items.flatMap((v) => {
        const formatted = `{{${v.key}}}`
        const main = { label: formatted, value: formatted, hint: v.description }
        const subs = v.subfields
          ? Object.entries(v.subfields).map(([sf, meta]) => {
              const sub = `{{${v.key}.${sf}}}`
              return { label: sub, value: sub, hint: meta.description }
            })
          : []
        return [main, ...subs]
      }),
    }))
}

export function useAgentVariableGroups(context = 'agent-prompt'): Ref<VariableGroup[]> {
  const groups = ref<VariableGroup[]>([])

  onMounted(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/variables?context=${context}`)
      if (res.ok) groups.value = toGroups((await res.json()) as VariableDefinition[])
    } catch {
      // El server puede no estar corriendo (dev con sólo la web levantada).
      // Sin variables el PromptField sigue siendo usable, sólo pierde el
      // autocompletado — no vale la pena romper el modal por eso.
    }
  })

  return groups
}
