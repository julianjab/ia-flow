<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Project, SourceRef } from '@ia-flow/shared';
import { useProjectsStore } from '@/features/projects/store';
import { useToastStore } from '@/stores/toast';
import SourceFormSwitch from '@/features/projects/sources/SourceFormSwitch.vue';

const props = defineProps<{ project: Project | null }>();

const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const draft = ref<SourceRef | null>(null);
const saving = ref(false);

watch(
  () => props.project?.id,
  () => {
    draft.value = props.project?.source
      ? { kind: props.project.source.kind, config: { ...(props.project.source.config ?? {}) } }
      : { kind: 'local', config: {} };
  },
  { immediate: true },
);

const currentKind = computed(() => draft.value?.kind ?? 'local');

// Field-by-field comparison to avoid false positives from key ordering.
const dirty = computed(() => {
  if (!props.project) return false;
  const original = props.project.source ?? null;
  if (!draft.value && !original) return false;
  if (!draft.value || !original) return true;
  if (draft.value.kind !== original.kind) return true;
  return JSON.stringify(draft.value.config ?? {}) !== JSON.stringify(original.config ?? {});
});

async function save() {
  if (!props.project || !dirty.value) return;
  saving.value = true;
  try {
    await projectsStore.update(props.project.id, { source: draft.value });
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
      De dónde se leen las tareas del proyecto. Cada fuente aporta su propia
      configuración; los agentes del proyecto se ejecutan igual sea cual sea.
    </p>

    <div class="ppt-status">
      <span class="ppt-status__label">Tipo actual:</span>
      <span :class="['ppt-badge', `ppt-badge--${currentKind}`]">{{ currentKind }}</span>
    </div>

    <SourceFormSwitch v-model="draft" />

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
  background: #f3f4f6;
  color: #374151;
}
.ppt-badge--github { background: #dbeafe; color: #1d4ed8; }
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
