<script setup lang="ts">
// Cap de concurrencia + reglas de admisión: con qué criterio ESTA máquina
// acepta trabajo. Es la mitad de la decisión de routing que no vive en el
// roster — la otra es el `provider` del agente (ver el skill de autoría).

import ConcurrencyCapField from '@/ui/ConcurrencyCapField.vue'
import { ref, watch } from 'vue'
import { ADMISSION_FIELDS, ADMISSION_OPS, type AdmissionRule, type GatewayAdmission } from './api'

const props = defineProps<{ modelValue: GatewayAdmission | null; saving: boolean }>()
const emit = defineEmits<{ save: [value: GatewayAdmission] }>()

const cap = ref<number | null>(null)
const rules = ref<AdmissionRule[]>([])
const draft = ref<AdmissionRule>({ field: 'assignee', op: 'equals', value: '' })

watch(
  () => props.modelValue,
  (next) => {
    if (!next) return
    cap.value = next.maxConcurrentRuns
    rules.value = next.rules.map((r) => ({ ...r }))
  },
  { immediate: true },
)

const OP_LABEL: Record<string, string> = {
  equals: 'es',
  notEquals: 'no es',
  matches: 'matchea',
  notMatches: 'no matchea',
}

function add(): void {
  if (!draft.value.value.trim()) return
  rules.value.push({ ...draft.value, value: draft.value.value.trim() })
  draft.value = { ...draft.value, value: '' }
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

      <ul v-if="rules.length" class="list">
        <li v-for="(rule, i) in rules" :key="i" class="list__item">
          <code class="list__rule">
            {{ rule.field }} {{ OP_LABEL[rule.op] ?? rule.op }} {{ rule.value }}
          </code>
          <button class="btn btn--ghost list__rm" title="quitar" @click="rules.splice(i, 1)">
            ×
          </button>
        </li>
      </ul>
      <p v-else class="hint">· sin reglas — acepta cualquier tarea</p>

      <div class="new">
        <select v-model="draft.field" class="new__select">
          <option v-for="f in ADMISSION_FIELDS" :key="f" :value="f">{{ f }}</option>
        </select>
        <select v-model="draft.op" class="new__select">
          <option v-for="o in ADMISSION_OPS" :key="o" :value="o">{{ OP_LABEL[o] }}</option>
        </select>
        <input
          v-model="draft.value"
          class="new__input"
          placeholder="julianjab · * como comodín"
          spellcheck="false"
          @keyup.enter="add"
        />
        <button class="btn" @click="add">agregar</button>
      </div>

      <button
        class="btn btn--primary"
        :disabled="saving"
        @click="emit('save', { maxConcurrentRuns: cap, rules: [...rules] })"
      >
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
.list {
  list-style: none;
  margin: 0.75rem 0;
  padding: 0;
}
.list__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  height: calc(var(--row-h) + 0.5rem);
  padding: 0 0.5rem;
  border: 1px solid var(--border);
  margin-bottom: 0.25rem;
  font-size: var(--fs-body-sm);
}
.list__rule {
  font-family: var(--font-mono);
}
.list__rm {
  height: var(--row-h);
  padding: 0 0.4rem;
}
.new {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 0.75rem;
}
.new__select,
.new__input {
  height: calc(var(--row-h) + 0.5rem);
  padding: 0 0.4rem;
  background: var(--panel-hi);
  border: 1px solid var(--border);
  color: var(--fg);
  font-size: var(--fs-body-sm);
}
.new__input {
  flex: 1;
  font-family: var(--font-mono);
}
</style>
