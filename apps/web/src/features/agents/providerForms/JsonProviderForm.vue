<script setup lang="ts">
import { ref, watch } from 'vue';

// Fallback form for provider ids without a dedicated component. Renders
// the config blob as a JSON textarea so a provider registered server-side
// stays editable in the UI without shipping a matching web release.
const props = defineProps<{ modelValue: Record<string, unknown> }>();
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>();

const raw = ref(JSON.stringify(props.modelValue ?? {}, null, 2));
const error = ref<string | null>(null);

watch(
  () => props.modelValue,
  (v) => {
    const next = JSON.stringify(v ?? {}, null, 2);
    if (next !== raw.value) raw.value = next;
  },
);

function onInput(e: Event) {
  const text = (e.target as HTMLTextAreaElement).value;
  raw.value = text;
  try {
    const parsed = text.trim() ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      error.value = null;
      emit('update:modelValue', parsed as Record<string, unknown>);
    } else {
      error.value = 'El JSON debe ser un objeto.';
    }
  } catch (e) {
    error.value = `JSON inválido: ${(e as Error).message}`;
  }
}
</script>

<template>
  <div class="jpf">
    <label class="jpf-label">Config (JSON)</label>
    <textarea
      class="jpf-textarea"
      :value="raw"
      spellcheck="false"
      rows="6"
      @input="onInput"
    ></textarea>
    <span v-if="error" class="jpf-error">{{ error }}</span>
    <p class="jpf-hint">
      Este provider no tiene un formulario dedicado. Escribe el config crudo aquí;
      el server lo valida con el schema propio del provider.
    </p>
  </div>
</template>

<style scoped>
.jpf { display: flex; flex-direction: column; gap: 0.35rem; }
.jpf-label { font-size: 0.85rem; color: #374151; font-weight: 500; }
.jpf-textarea {
  padding: 0.5rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.85rem;
  resize: vertical;
}
.jpf-error { color: #b91c1c; font-size: 0.8rem; }
.jpf-hint { margin: 0; font-size: 0.75rem; color: #6b7280; }
</style>
