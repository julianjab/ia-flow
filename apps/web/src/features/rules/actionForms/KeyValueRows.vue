<script setup lang="ts">
import { computed } from 'vue'

// Un `Record<string, string>` editado como filas `clave = valor`.
//
// Lo comparten los headers de `http` y el env de `script`: los dos son
// allow-lists de nombres, y editarlos como JSON crudo pedía escribir llaves y
// comillas para agregar un header.

const props = defineProps<{
  modelValue?: Record<string, string>
  keyPlaceholder?: string
  valuePlaceholder?: string
  addLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, string>): void
}>()

/**
 * Las filas salen del modelo en cada render, no de un `ref` propio.
 *
 * Un estado local exigía sincronizarlo con un `watch` y se desincronizaba al
 * cambiar de acción en el mismo modal. El costo es que una clave vacía no
 * sobrevive —no tiene dónde guardarse en un `Record`—, así que agregar una fila
 * escribe una clave provisoria en vez de una vacía.
 */
const rows = computed<[string, string][]>(() => Object.entries(props.modelValue ?? {}))

function push(entries: [string, string][]) {
  emit('update:modelValue', Object.fromEntries(entries))
}

function setKey(i: number, key: string) {
  const next = rows.value.map((r, idx): [string, string] => (idx === i ? [key, r[1]] : r))
  push(next)
}

function setValue(i: number, value: string) {
  push(rows.value.map((r, idx): [string, string] => (idx === i ? [r[0], value] : r)))
}

function remove(i: number) {
  push(rows.value.filter((_, idx) => idx !== i))
}

/** La clave provisoria de una fila nueva. Numerada para no pisar la anterior
 *  si se agregan dos seguidas sin escribir nada. */
function add() {
  let n = 1
  const taken = new Set(rows.value.map(([k]) => k))
  while (taken.has(`nueva-${n}`)) n++
  push([...rows.value, [`nueva-${n}`, '']])
}
</script>

<template>
  <div class="af-list">
    <div v-for="([key, value], i) in rows" :key="i" class="af-list-row">
      <input
        class="af-field af-mono af-list-key"
        :value="key"
        :placeholder="keyPlaceholder"
        @change="setKey(i, ($event.target as HTMLInputElement).value)"
      />
      <span class="af-eq">=</span>
      <input
        class="af-field af-mono af-list-val"
        :value="value"
        :placeholder="valuePlaceholder"
        @input="setValue(i, ($event.target as HTMLInputElement).value)"
      />
      <button type="button" class="af-drop" aria-label="Quitar" @click="remove(i)">✕</button>
    </div>
    <button type="button" class="af-add" @click="add">{{ addLabel ?? '+ fila' }}</button>
  </div>
</template>

<style scoped src="./fields.css"></style>
