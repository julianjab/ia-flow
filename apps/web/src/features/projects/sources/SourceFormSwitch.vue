<script setup lang="ts">
import type { SourceRef } from '@ia-flow/shared';
import { computed } from 'vue';
import GitHubSourceForm from './GitHubSourceForm.vue';
import JsonSourceForm from './JsonSourceForm.vue';
import LocalSourceForm from './LocalSourceForm.vue';
import { SUPPORTED_KINDS } from './kinds';

// Registry of source kinds → their per-config form component.
// Adding a new source with a dedicated form: add an entry here. Without an
// entry, JsonSourceForm renders a textarea so the source is still usable.
const KIND_FORMS: Record<string, unknown> = {
  github: GitHubSourceForm,
  local: LocalSourceForm,
};

const props = defineProps<{ modelValue: SourceRef | null | undefined }>();
const emit = defineEmits<{ 'update:modelValue': [value: SourceRef | null] }>();

const kind = computed({
  get: () => props.modelValue?.kind ?? 'local',
  set: (v: string) => emit('update:modelValue', { kind: v, config: {} }),
});

const config = computed(() => (props.modelValue?.config ?? {}) as Record<string, unknown>);

function updateConfig(next: Record<string, unknown>) {
  emit('update:modelValue', { kind: kind.value, config: next });
}

const currentForm = computed(() => KIND_FORMS[kind.value] ?? JsonSourceForm);
</script>

<template>
  <div class="sfs">
    <label class="sfs-field">
      <span class="sfs-label">Fuente</span>
      <select v-model="kind" class="sfs-select">
        <option v-for="k in SUPPORTED_KINDS" :key="k" :value="k">{{ k }}</option>
        <!-- If the project already has a kind not in the supported list,
             surface it so the user can see and re-pick — but they can't
             pick it back once switched away. -->
        <option
          v-if="modelValue?.kind && !SUPPORTED_KINDS.includes(modelValue.kind as any)"
          :value="modelValue.kind"
        >{{ modelValue.kind }} (personalizado)</option>
      </select>
    </label>
    <component
      :is="currentForm"
      :model-value="config"
      @update:model-value="updateConfig"
    />
  </div>
</template>

<style scoped>
.sfs { display: flex; flex-direction: column; gap: 0.75rem; }
.sfs-field { display: flex; flex-direction: column; gap: 0.35rem; }
.sfs-label { font-size: 0.85rem; color: var(--fg-mute); font-weight: 500; }
.sfs-select {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.9rem;
  background: var(--panel);
}
</style>
