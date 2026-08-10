<script setup lang="ts">
import { computed } from 'vue';

// Config shape for source.kind === 'github'. Kept flat + typed here rather
// than shared/, since shared is provider-agnostic (see SourceRefSchema).
export interface GitHubSourceConfig {
  url?: string;
}

const props = defineProps<{ modelValue: GitHubSourceConfig }>();
const emit = defineEmits<{ 'update:modelValue': [value: GitHubSourceConfig] }>();

const url = computed({
  get: () => props.modelValue.url ?? '',
  set: (v: string) => emit('update:modelValue', { ...props.modelValue, url: v }),
});
</script>

<template>
  <div class="ghsf">
    <label class="ghsf-field">
      <span class="ghsf-label">GitHub Project URL</span>
      <input
        v-model="url"
        class="ghsf-input"
        placeholder="https://github.com/orgs/xxx/projects/N"
      />
    </label>
    <a
      v-if="url"
      :href="url"
      target="_blank"
      rel="noreferrer noopener"
      class="ghsf-link"
    >
      Abrir en GitHub ↗
    </a>
  </div>
</template>

<style scoped>
.ghsf { display: flex; flex-direction: column; gap: 0.35rem; }
.ghsf-field { display: flex; flex-direction: column; gap: 0.35rem; }
.ghsf-label { font-size: 0.85rem; color: #374151; font-weight: 500; }
.ghsf-input {
  padding: 0.5rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.9rem;
}
.ghsf-link {
  font-size: 0.75rem;
  color: #2563eb;
  text-decoration: none;
  align-self: flex-start;
}
.ghsf-link:hover { text-decoration: underline; }
</style>
