<script setup lang="ts">
import { computed } from 'vue';

// Config shape for source.kind === 'github-issues' — mirrors the validation in
// createDefaultSourceFactory (packages/issue-sources/src/source-factory.ts):
// owner + repo son obligatorios, anchorLabel es opcional.
export interface GitHubIssuesSourceConfig {
  owner?: string;
  repo?: string;
  anchorLabel?: string;
}

const props = defineProps<{ modelValue: GitHubIssuesSourceConfig }>();
const emit = defineEmits<{ 'update:modelValue': [value: GitHubIssuesSourceConfig] }>();

function field(key: keyof GitHubIssuesSourceConfig) {
  return computed({
    get: () => props.modelValue[key] ?? '',
    set: (v: string) => emit('update:modelValue', { ...props.modelValue, [key]: v }),
  });
}

const owner = field('owner');
const repo = field('repo');
const anchorLabel = field('anchorLabel');

const repoUrl = computed(() =>
  owner.value && repo.value ? `https://github.com/${owner.value}/${repo.value}/issues` : '',
);
</script>

<template>
  <div class="gisf">
    <label class="gisf-field">
      <span class="gisf-label">Owner *</span>
      <input v-model="owner" class="gisf-input" placeholder="julianjab" />
    </label>

    <label class="gisf-field">
      <span class="gisf-label">Repo *</span>
      <input v-model="repo" class="gisf-input" placeholder="accountant" />
    </label>

    <label class="gisf-field">
      <span class="gisf-label">Anchor label</span>
      <input v-model="anchorLabel" class="gisf-input" placeholder="ia-flow" />
      <span class="gisf-hint">
        Opcional. Sin ella el source vigila TODO issue abierto del repo.
      </span>
    </label>

    <a
      v-if="repoUrl"
      :href="repoUrl"
      target="_blank"
      rel="noreferrer noopener"
      class="gisf-link"
    >
      Abrir issues en GitHub ↗
    </a>
  </div>
</template>

<style scoped>
.gisf { display: flex; flex-direction: column; gap: 0.75rem; }
.gisf-field { display: flex; flex-direction: column; gap: 0.35rem; }
.gisf-label { font-size: 0.85rem; color: var(--fg-mute); font-weight: 500; }
.gisf-hint { font-size: 0.75rem; color: var(--fg-dim); }
.gisf-input {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border-hi);
  font-size: 0.9rem;
}
.gisf-link {
  font-size: 0.75rem;
  color: var(--accent);
  text-decoration: none;
  align-self: flex-start;
}
.gisf-link:hover { text-decoration: underline; }
</style>
