<script setup lang="ts">
import type { Project } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';
import { useProjectsStore } from '@/features/projects/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useToastStore } from '@/stores/toast';

const props = defineProps<{ project: Project | null }>();

const projectsStore = useProjectsStore();
const configStore = useProjectConfigStore();
const toastStore = useToastStore();

const nameDraft = ref('');
const urlDraft = ref('');
const saving = ref(false);

// Reset drafts when we navigate between projects or the list finishes loading.
watch(
  () => props.project?.id,
  () => {
    nameDraft.value = props.project?.name ?? '';
    urlDraft.value = props.project?.githubProjectUrl ?? '';
  },
  { immediate: true },
);

const dirty = computed(
  () =>
    (props.project && nameDraft.value.trim() !== props.project.name) ||
    (props.project && (urlDraft.value.trim() || null) !== (props.project.githubProjectUrl ?? null)),
);

async function save() {
  if (!props.project || !dirty.value) return;
  saving.value = true;
  try {
    await projectsStore.update(props.project.id, {
      name: nameDraft.value.trim(),
      githubProjectUrl: urlDraft.value.trim() || null,
    });
    toastStore.success('Proyecto actualizado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

async function archive() {
  if (!props.project) return;
  if (!window.confirm(`¿Archivar el proyecto '${props.project.name}'?`)) return;
  try {
    await projectsStore.archive(props.project.id);
    toastStore.success('Proyecto archivado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
</script>

<template>
  <section v-if="props.project" class="pot-section">
    <h2>Overview</h2>

    <div class="pot-grid">
      <label class="pot-field">
        <span class="pot-field__label">Nombre</span>
        <input v-model="nameDraft" class="pot-input" />
      </label>
      <label class="pot-field">
        <span class="pot-field__label">ID</span>
        <input :value="props.project.id" class="pot-input pot-input--mono" disabled />
      </label>
      <label class="pot-field pot-field--full">
        <span class="pot-field__label">GitHub Project URL</span>
        <input v-model="urlDraft" class="pot-input" placeholder="https://github.com/orgs/xxx/projects/N" />
      </label>
    </div>

    <div class="pot-actions">
      <button class="pot-btn pot-btn--primary" :disabled="!dirty || saving" @click="save">
        {{ saving ? 'Guardando…' : 'Guardar' }}
      </button>
      <button class="pot-btn pot-btn--danger" @click="archive">Archivar proyecto</button>
    </div>

    <hr />

    <div class="pot-summary">
      <div class="pot-summary__item">
        <span class="pot-summary__label">Agentes del proyecto</span>
        <span class="pot-summary__value">{{ configStore.config?.agents?.length ?? 0 }}</span>
      </div>
      <div class="pot-summary__item">
        <span class="pot-summary__label">Statuses</span>
        <span class="pot-summary__value">{{ configStore.config?.statuses?.length ?? 0 }}</span>
      </div>
      <div class="pot-summary__item">
        <span class="pot-summary__label">System Prompts</span>
        <span class="pot-summary__value">{{ configStore.config?.systemPrompts?.length ?? 0 }}</span>
      </div>
    </div>
  </section>
  <div v-else class="pot-empty">Proyecto no encontrado.</div>
</template>

<style scoped>
.pot-section {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 1.25rem;
}
.pot-section h2 { margin: 0 0 1rem; font-size: 1.15rem; }
.pot-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.85rem;
}
.pot-field { display: flex; flex-direction: column; gap: 0.35rem; }
.pot-field--full { grid-column: 1 / -1; }
.pot-field__label { font-size: 0.85rem; color: #374151; font-weight: 500; }
.pot-input {
  padding: 0.5rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.9rem;
}
.pot-input--mono { font-family: ui-monospace, SFMono-Regular, monospace; }
.pot-input:disabled { background: #f9fafb; color: #6b7280; }
.pot-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
.pot-btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
  border: 1px solid transparent;
}
.pot-btn--primary { background: #111827; color: #fff; }
.pot-btn--danger { background: #fff; color: #b91c1c; border-color: #fecaca; }
.pot-btn:disabled { opacity: 0.5; cursor: not-allowed; }
hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5rem 0; }
.pot-summary { display: flex; gap: 2rem; flex-wrap: wrap; }
.pot-summary__item { display: flex; flex-direction: column; gap: 0.15rem; }
.pot-summary__label { font-size: 0.8rem; color: #6b7280; }
.pot-summary__value { font-size: 1.25rem; font-weight: 600; }
.pot-empty {
  padding: 2rem;
  color: #6b7280;
  text-align: center;
}
</style>
