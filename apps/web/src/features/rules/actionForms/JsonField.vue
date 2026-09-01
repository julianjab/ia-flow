<script setup lang="ts">
import { ref, watch } from 'vue'

// Un valor JSON editado como texto.
//
// El texto crudo es el estado: parsear en cada tecla y re-serializar desde el
// objeto reformatearía lo que se está escribiendo. Mientras no parsee, el
// modelo no se toca y el error se muestra — así un JSON a medio escribir no se
// pierde ni se guarda roto.

const props = defineProps<{
  modelValue?: unknown
  placeholder?: string
  rows?: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: unknown): void
}>()

const serialize = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2))

const raw = ref(serialize(props.modelValue))
const error = ref<string | null>(null)

watch(
  () => props.modelValue,
  (v) => {
    const next = serialize(v)
    // Sólo cuando el cambio vino de afuera: comparar contra lo tipeado evita
    // que el eco del propio `patch` le reformatee el texto al que escribe.
    if (next !== serialize(parseOrUndefined(raw.value))) raw.value = next
  },
  { deep: true },
)

function parseOrUndefined(text: string): unknown {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function onInput(e: Event) {
  const text = (e.target as HTMLTextAreaElement).value
  raw.value = text
  if (!text.trim()) {
    error.value = null
    emit('update:modelValue', undefined)
    return
  }
  try {
    emit('update:modelValue', JSON.parse(text))
    error.value = null
  } catch (err) {
    error.value = `JSON inválido: ${(err as Error).message}`
  }
}
</script>

<template>
  <textarea
    class="ff-field ff-mono ff-textarea"
    :rows="rows ?? 3"
    :value="raw"
    :placeholder="placeholder"
    spellcheck="false"
    @input="onInput"
  />
  <p v-if="error" class="ff-error">{{ error }}</p>
</template>

<style scoped src="@/ui/form-fields.css"></style>
