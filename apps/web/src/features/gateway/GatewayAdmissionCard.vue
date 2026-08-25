<script setup lang="ts">
// Cap de concurrencia + reglas de admisión: con qué criterio ESTA máquina
// acepta trabajo. Es la mitad de la decisión de routing que no vive en el
// roster — la otra es el `provider` del agente.
//
// Las filas son las MISMAS que edita el `when` de un agente
// (`ui/ConditionRowsEditor`): son dos DSL distintos —el del engine contra los
// campos del issue, el de admisión contra lo que la tarea trae— pero se
// editan igual, así que la fila vive en `ui/` y cada uno le pasa sus campos y
// sus operadores.

import ConcurrencyCapField from '@/ui/ConcurrencyCapField.vue'
import ConditionRowsEditor from '@/ui/ConditionRowsEditor.vue'
import type { ConditionRow } from '@/ui/condition-rows'
import { ref, watch } from 'vue'
import { ADMISSION_FIELDS, ADMISSION_OPS, type AdmissionRule, type GatewayAdmission } from './api'

const props = defineProps<{ modelValue: GatewayAdmission | null; saving: boolean }>()
const emit = defineEmits<{ save: [value: GatewayAdmission] }>()

const OP_LABEL: Record<string, string> = {
  equals: 'es',
  notEquals: 'no es',
  matches: 'matchea',
  notMatches: 'no matchea',
}
const OPS = ADMISSION_OPS.map((value) => ({ value, label: OP_LABEL[value] ?? value }))

const cap = ref<number | null>(null)
const rows = ref<ConditionRow[]>([])

watch(
  () => props.modelValue,
  (next) => {
    if (!next) return
    cap.value = next.maxConcurrentRuns
    rows.value = next.rules.map((r) => ({ ...r }))
  },
  { immediate: true },
)

/** Una fila a medio escribir (sin valor) no es una regla: el gateway la
 *  descartaría igual, y mandarla haría que la pantalla parpadee al releer. */
function save(): void {
  const rules = rows.value
    .filter((r) => r.value.trim())
    .map((r) => ({ ...r, value: r.value.trim() }) as AdmissionRule)
  emit('save', { maxConcurrentRuns: cap.value, rules })
}
</script>

<template>
  <section class="panel">
    <header class="panel__header">admisión</header>
    <div class="body">
      <p class="hint">
        Con qué criterio esta máquina toma trabajo. Todas las reglas tienen que cumplirse. Una
        regla sobre un dato que la tarea no trae no rechaza.
      </p>

      <ConcurrencyCapField v-model="cap" label="Runs simultáneos" inherit-label="Sin límite" />

      <ConditionRowsEditor
        v-model="rows"
        :fields="ADMISSION_FIELDS"
        :ops="OPS"
        value-placeholder="julianjab · * como comodín"
        add-label="+ regla"
        :empty-row="() => ({ field: 'assignee', op: 'equals', value: '' })"
      />

      <button class="btn btn--primary save" :disabled="saving" @click="save">
        {{ saving ? 'guardando…' : 'guardar' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.body {
  padding: 0.75rem;
}
.hint {
  margin: 0 0 0.75rem;
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
}
.save {
  margin-top: 0.75rem;
}
</style>
