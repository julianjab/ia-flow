<script setup lang="ts">
import { ref, watch } from 'vue';

// Fallback form for source kinds without a dedicated component. Renders
// the config as a JSON textarea so a new source registered in the server
// is fully usable from the UI without a matching web release.
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
  <div class="jsf">
    <label class="jsf-label">Config (JSON)</label>
    <textarea
      class="jsf-textarea"
      :value="raw"
      spellcheck="false"
      rows="6"
      @input="onInput"
    ></textarea>
    <span v-if="error" class="jsf-error">{{ error }}</span>
  </div>
</template>

<style scoped>
.jsf { display: flex; flex-direction: column; gap: 0.35rem; }
.jsf-label { font-size: 0.85rem; color: var(--fg-mute); font-weight: 500; }
.jsf-textarea {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.85rem;
  resize: vertical;
}
.jsf-error {
  color: var(--danger);
  font-size: 0.8rem;
}
</style>
