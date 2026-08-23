<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, ref, watch } from 'vue';
import type { Project, SourceRef } from '@ia-flow/shared';
import { sourceKindLabel } from '@/features/projects/meta';
import { useProjectsStore } from '@/features/projects/store';
import { useToastStore } from '@/stores/toast';
import SourceFormSwitch from '@/features/projects/sources/SourceFormSwitch.vue';
import DaemonModeField from '@/features/projects/DaemonModeField.vue';
import ConcurrencyCapField from '@/ui/ConcurrencyCapField.vue';

const props = defineProps<{ project: Project | null }>();

const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const draft = ref<SourceRef | null>(null);
// Raw settings.daemonMode: string o null (= heredar). Se guarda junto con la
// fuente porque son la misma decisión operativa: de dónde leo y cuándo miro.
const daemonMode = ref<string | null>(null);
// settings.maxConcurrentDispatches: tope de agentes corriendo a la vez en
// ESTE proyecto. null = heredar el default global de env
// (IA_FLOW_MAX_CONCURRENT_DISPATCHES). Vive junto al modo de disparo porque
// es la misma decisión operativa: cuándo miro y cuánto largo a la vez.
const maxConcurrent = ref<number | null>(null);
const saving = ref(false);

watch(
  () => props.project?.id,
  () => {
    draft.value = props.project?.source
      ? { kind: props.project.source.kind, config: { ...(props.project.source.config ?? {}) } }
      : { kind: 'local', config: {} };
    const raw = props.project?.settings?.daemonMode;
    daemonMode.value = typeof raw === 'string' && raw ? raw : null;
    maxConcurrent.value = originalMaxConcurrent.value;
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

const originalDaemonMode = computed(() => {
  const raw = props.project?.settings?.daemonMode;
  return typeof raw === 'string' && raw ? raw : null;
});

const modeDirty = computed(() => daemonMode.value !== originalDaemonMode.value);

const originalMaxConcurrent = computed(() => {
  const raw = props.project?.settings?.maxConcurrentDispatches;
  return typeof raw === 'number' && raw > 0 ? raw : null;
});

const capDirty = computed(() => maxConcurrent.value !== originalMaxConcurrent.value);

const anyDirty = computed(() => dirty.value || modeDirty.value || capDirty.value);

async function save() {
  if (!props.project || !anyDirty.value) return;
  saving.value = true;
  try {
    await projectsStore.update(props.project.id, {
      source: draft.value,
      // null (no undefined) para limpiarlo: el PATCH mergea settings por key,
      // así que undefined dejaría el modo viejo persistido.
      settings: {
        daemonMode: daemonMode.value,
        maxConcurrentDispatches: maxConcurrent.value,
      },
    });
    toastStore.success('Provider actualizado');
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
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
      <span :class="['ppt-badge', `ppt-badge--${currentKind}`]">{{ sourceKindLabel(currentKind) }}</span>
    </div>

    <SourceFormSwitch v-model="draft" />

    <DaemonModeField v-model="daemonMode" />

    <ConcurrencyCapField
      v-model="maxConcurrent"
      label="Máx. agentes en paralelo"
      inherit-label="Heredar el default global"
      hint="Los issues que no entran no se pierden: quedan en cola y se despachan al liberarse un slot."
    />

    <div class="ppt-actions">
      <button class="ppt-btn ppt-btn--primary" :disabled="!anyDirty || saving" @click="save">
        {{ saving ? 'Guardando…' : 'Guardar' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.ppt-section {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1.25rem;
}
.ppt-section h2 { margin: 0 0 0.5rem; font-size: 1.15rem; }
.ppt-desc { margin: 0 0 1rem; color: var(--fg-dim); font-size: 0.9rem; }
.ppt-status { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
.ppt-status__label { font-size: 0.85rem; color: var(--fg-mute); }
.ppt-badge {
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 500;
  background: var(--panel-hi);
  color: var(--fg-mute);
}
.ppt-badge--github { background: var(--panel-hi); color: var(--accent); }
.ppt-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
.ppt-btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
  border: 1px solid transparent;
}
.ppt-btn--primary { background: var(--fg); color: var(--panel); }
.ppt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
