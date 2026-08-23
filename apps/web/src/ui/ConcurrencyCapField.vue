<script setup lang="ts">
// Input de un cap de concurrencia. Sin conocimiento de dominio: lo usan el
// tab de provider de un proyecto, el editor de agentes y la sección de
// providers, que declaran el mismo tipo de número con distinto alcance.
//
// La convención de "vacío" es la del engine (ver capacity.ts en
// @ia-flow/agent-engine): vacío emite `null` y un 0 tampoco limita nada.
// Emitimos `null` y no `undefined` a propósito — los PATCH de settings /
// config mergean por key, así que `undefined` dejaría el valor viejo en la DB
// en vez de borrarlo.

import { computed, useId } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: number | null | undefined
    label: string
    /** Qué se aplica cuando el campo queda vacío. */
    inheritLabel?: string
    hint?: string
  }>(),
  { inheritLabel: 'Sin límite', hint: undefined },
)

const emit = defineEmits<{ 'update:modelValue': [value: number | null] }>()

const inputId = `ccf-${useId()}`

const value = computed({
  get: () => (props.modelValue == null ? '' : String(props.modelValue)),
  set: (raw: string) => {
    const n = Number.parseInt(raw, 10)
    emit('update:modelValue', Number.isFinite(n) && n > 0 ? n : null)
  },
})

const effective = computed(() =>
  props.modelValue && props.modelValue > 0
    ? `${props.modelValue} en paralelo`
    : props.inheritLabel,
)
</script>

<template>
  <div class="ccf">
    <label class="uc-label" :for="inputId">{{ label }}</label>
    <input
      :id="inputId"
      v-model="value"
      class="ccf-input"
      type="number"
      min="1"
      step="1"
      inputmode="numeric"
      :placeholder="inheritLabel"
    />
    <span class="ccf-hint">
      Efectivo: <strong>{{ effective }}</strong
      >. <template v-if="hint">{{ hint }}</template>
    </span>
  </div>
</template>

<style scoped>
.ccf { display: flex; flex-direction: column; gap: 0.2rem; }
.ccf-hint { font-size: var(--fs-body-sm); color: var(--fg-dim); line-height: 1.4; }
.ccf-input {
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  width: 10ch;
}
</style>
