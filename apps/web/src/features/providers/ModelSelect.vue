<script setup lang="ts">
const props = defineProps<{
  modelValue: string | undefined;
  allowEmpty?: boolean;
  emptyLabel?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | undefined): void;
}>();

const MODELS = [
  { value: 'claude-sonnet-4-6',       label: 'Sonnet 4.6', desc: 'Best for everyday tasks'       },
  { value: 'claude-opus-4-7',         label: 'Opus 4.7',   desc: 'Most capable for complex work' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', desc: 'Fastest for quick answers'    },
] as const;

function onChange(val: string) {
  emit('update:modelValue', val || undefined);
}
</script>

<template>
  <select
    class="model-select"
    :value="modelValue ?? ''"
    @change="onChange(($event.target as HTMLSelectElement).value)"
  >
    <option v-if="allowEmpty" value="">{{ emptyLabel ?? '— default de Claude CLI —' }}</option>
    <option
      v-for="m in MODELS"
      :key="m.value"
      :value="m.value"
    >{{ m.label }} · {{ m.desc }}</option>
  </select>
</template>

<style scoped>
.model-select {
  /* `flex: 1` sin `min-width: 0` no encoge: el mínimo de un elemento flex es
     el de su contenido, y los nombres de modelo son largos. Es la causa de que
     esta vista empujara la página 197px en un celular. */
  flex: 1;
  min-width: 0;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  background: var(--panel);
  font-size: 0.84rem;
  color: var(--fg);
  cursor: pointer;
  outline: none;
}
.model-select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}
</style>
