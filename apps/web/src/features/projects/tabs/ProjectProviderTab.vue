<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Project } from '@ia-flow/shared';
import { useProjectsStore } from '@/features/projects/store';
import { useToastStore } from '@/stores/toast';

const props = defineProps<{ project: Project | null }>();

const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const urlDraft = ref('');
const saving = ref(false);

watch(
  () => props.project?.id,
  () => { urlDraft.value = props.project?.githubProjectUrl ?? ''; },
  { immediate: true },
);

const providerType = computed(() => (urlDraft.value.trim() ? 'github' : 'local'));

const dirty = computed(
  () =>
    props.project &&
    (urlDraft.value.trim() || null) !== (props.project.githubProjectUrl ?? null),
);

async function save() {
  if (!props.project || !dirty.value) return;
  saving.value = true;
  try {
    await projectsStore.update(props.project.id, {
      githubProjectUrl: urlDraft.value.trim() || null,
    });
    toastStore.success('Provider actualizado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="ppt-section">
    <h2>Provider (manager)</h2>
    <p class="ppt-desc">
      De dónde se leen las tareas del proyecto. Hoy soporta GitHub Projects; si dejas la URL vacía,
      el proyecto queda con tareas locales.
    </p>

    <div class="ppt-status">
      <span class="ppt-status__label">Tipo actual:</span>
      <span :class="['ppt-badge', `ppt-badge--${providerType}`]">{{ providerType }}</span>
    </div>

    <label class="ppt-field">
      <span class="ppt-field__label">GitHub Project URL</span>
      <input
        v-model="urlDraft"
        class="ppt-input"
        placeholder="https://github.com/orgs/xxx/projects/N"
      />
    </label>

    <div class="ppt-actions">
      <button class="ppt-btn ppt-btn--primary" :disabled="!dirty || saving" @click="save">
        {{ saving ? 'Guardando…' : 'Guardar' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.ppt-section {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 1.25rem;
}
.ppt-section h2 { margin: 0 0 0.5rem; font-size: 1.15rem; }
.ppt-desc { margin: 0 0 1rem; color: #6b7280; font-size: 0.9rem; }
.ppt-status { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
.ppt-status__label { font-size: 0.85rem; color: #374151; }
.ppt-badge {
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 500;
}
.ppt-badge--github { background: #dbeafe; color: #1d4ed8; }
.ppt-badge--local  { background: #f3f4f6; color: #374151; }
.ppt-field { display: flex; flex-direction: column; gap: 0.35rem; }
.ppt-field__label { font-size: 0.85rem; color: #374151; font-weight: 500; }
.ppt-input {
  padding: 0.5rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.9rem;
}
.ppt-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
.ppt-btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
  border: 1px solid transparent;
}
.ppt-btn--primary { background: #111827; color: #fff; }
.ppt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
