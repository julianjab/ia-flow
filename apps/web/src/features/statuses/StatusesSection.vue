<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, onMounted, ref, watch } from 'vue';
import type { StatusConfig } from '@ia-flow/shared';
import StatusConfigModal from '@/features/statuses/StatusConfigModal.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import EditableCard from '@/ui/EditableCard.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProjectsStore } from '@/features/projects/store';
import { useToastStore } from '@/stores/toast';
import {
  fetchProjectStatuses,
  type StatusOption,
} from '@/features/projects/sourceApi';
import {
  createStatus as apiCreateStatus,
  deleteStatus as apiDeleteStatus,
  updateStatus as apiUpdateStatus,
} from '@/features/statuses/statusesApi';

const projectConfigStore = useProjectConfigStore();
const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const statusModalOpen = ref(false);
const editingStatus = ref<StatusConfig | null>(null);
const sourceStatuses = ref<StatusOption[]>([]);
const statusNameLocked = ref(false);

// Status names come 100% from the project's source. The server-side factory
// picks the right ProjectSource per project kind (github, local, ...); the
// UI has no kind-specific branches. Per-status config (position, etc.) is
// looked up from the DB by name. Qué corre en cada status NO se resuelve acá:
// desde la migración 059 lo decide una regla, y la respuesta vive en Pipeline.
const allStatuses = computed(() => {
  const configMap = new Map(
    (projectConfigStore.config?.statuses ?? []).map((s) => [s.name.toLowerCase(), s]),
  );
  return sourceStatuses.value.map(({ name }) => ({
    name,
    config: configMap.get(name.toLowerCase()) ?? null,
  }));
});

function openConfigureStatus(name: string, config: StatusConfig | null) {
  editingStatus.value = config ?? ({ name } as StatusConfig);
  statusNameLocked.value = true;
  statusModalOpen.value = true;
}

/** Sólo se puede borrar lo que ESTE proyecto configuró: el status en sí lo
 *  define la fuente y no es nuestro para borrar. */
const editingIsConfigured = computed(() =>
  (projectConfigStore.config?.statuses ?? []).some(
    (s) => s.name.toLowerCase() === (editingStatus.value?.name ?? '').toLowerCase(),
  ),
);

function askDeleteStatus(statusName: string) {
  askConfirm({
    title: 'Eliminar configuración de status',
    message: `¿Eliminar la configuración del status '${statusName}'?`,
    confirmLabel: 'Eliminar',
    onConfirm: async () => {
      await deleteStatus(statusName);
      statusModalOpen.value = false;
    },
  });
}

async function deleteStatus(statusName: string) {
  const pid = projectsStore.activeProjectId;
  if (!pid) return;
  try {
    await apiDeleteStatus(pid, statusName);
    await projectConfigStore.fetch();
    toastStore.success(`Status '${statusName}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  }
}

async function handleStatusSave(status: StatusConfig) {
  const pid = projectsStore.activeProjectId;
  if (!pid) {
    toastStore.error('Selecciona un proyecto antes de guardar');
    return;
  }
  const exists = (projectConfigStore.config?.statuses ?? []).some(
    (s) => s.name.toLowerCase() === status.name.toLowerCase(),
  );
  try {
    if (exists) {
      await apiUpdateStatus(pid, status);
    } else {
      await apiCreateStatus(pid, status);
    }
    await projectConfigStore.fetch();
    statusModalOpen.value = false;
    toastStore.success(`Status '${status.name}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  }
}

async function loadSourceStatuses() {
  const pid = projectsStore.activeProjectId;
  if (!pid) {
    sourceStatuses.value = [];
    return;
  }
  try {
    const res = await fetchProjectStatuses(pid);
    sourceStatuses.value = res.statuses ?? [];
  } catch {
    sourceStatuses.value = [];
  }
}

onMounted(() => {
  void loadSourceStatuses();
});

// Reload source-derived data whenever the user switches projects.
watch(() => projectsStore.activeProjectId, () => {
  void loadSourceStatuses();
});

interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}
const pendingConfirm = ref<PendingConfirm | null>(null);
function askConfirm(c: PendingConfirm) { pendingConfirm.value = c; }
async function runConfirm() {
  const c = pendingConfirm.value;
  if (!c) return;
  pendingConfirm.value = null;
  await c.onConfirm();
}
function cancelConfirm() { pendingConfirm.value = null; }
</script>

<template>
  <section class="settings-section">
    <h2>Statuses</h2>
    <p class="section-desc">
      Las etapas del proyecto, tal como las devuelve la fuente. Acá se les da nombre y orden
      para mostrarlas; <b>qué corre en cada una lo deciden las reglas</b>, en Pipeline.
    </p>

    <div v-if="!allStatuses.length" class="repos-empty">
      No hay statuses aún. Crea una tarea primero.
    </div>

    <div v-else class="status-cards">
      <!-- Sin ✕ en la fila: borrar la configuración vive en el modal, que es
           donde se ve qué se está por borrar. -->
      <EditableCard
        v-for="{ name, config: sc } in allStatuses"
        :key="name"
        class="status-card"
        clickable
        @edit="openConfigureStatus(name, sc)"
      >
        <span class="status-card-name">{{ name }}</span>
        <div class="status-card-body">
          <router-link
            :to="{
              name: 'projects.detail',
              params: { id: projectsStore.activeProjectId, tab: 'pipeline' },
            }"
            class="sc-rules-link"
            @click.stop
          >Ver qué corre acá →</router-link>
          <span class="sc-add-hint">+ Configurar status</span>
        </div>
      </EditableCard>
    </div>
  </section>

  <StatusConfigModal
    :open="statusModalOpen"
    :status-config="editingStatus"
    :status-options="sourceStatuses.map((s) => s.name)"
    :name-locked="statusNameLocked"
    :deletable="editingIsConfigured"
    @close="statusModalOpen = false"
    @save="handleStatusSave"
    @delete="askDeleteStatus"
  />

  <ConfirmDialog
    :open="pendingConfirm != null"
    :title="pendingConfirm?.title"
    :message="pendingConfirm?.message ?? ''"
    :confirm-label="pendingConfirm?.confirmLabel"
    danger
    @confirm="runConfirm"
    @cancel="cancelConfirm"
  />
</template>

<style scoped>
.settings-section { border: 1px solid var(--border); padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: var(--fg-dim); line-height: 1.5; }

.repos-empty { font-size: var(--fs-body-sm); color: var(--fg-dim); padding: 0.5rem 0; }

.status-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.25rem; }
/* La caja, el hover y el ✕ los pone `EditableCard`; acá sólo el contenido. */
.status-card { padding-top: 0.3rem; padding-bottom: 0.3rem; }
.status-card-name { font-size: var(--fs-body-sm); font-weight: 700; color: var(--fg); }
.status-card-body { display: flex; flex-direction: column; gap: 0.2rem; }
.sc-rules-link { font-size: var(--fs-micro); color: var(--ai); text-decoration: none; }
.sc-rules-link:hover { text-decoration: underline; background: none; }
.sc-add-hint { font-size: var(--fs-micro); color: var(--accent); font-weight: 500; }

.sc-agent-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border-mute);
  background: var(--panel-alt);
  color: var(--fg-mute);
  text-decoration: none;
}
.sc-agent-row:hover { background: var(--panel-hi); color: var(--fg); text-decoration: none; }
.sc-agent-row--first { border-color: var(--accent); }
.sc-agent-order { font-size: var(--fs-micro); color: var(--fg-dim); width: 1.4rem; flex-shrink: 0; }
.sc-agent-row--first .sc-agent-order { color: var(--accent); }
.sc-agent-name { font-family: var(--font-mono); font-size: var(--fs-body-sm); font-weight: 600; color: var(--fg); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-agent-off { font-size: var(--fs-micro); color: var(--fg-dim); flex-shrink: 0; }
.sc-agent-hint { font-size: var(--fs-micro); color: var(--accent); flex-shrink: 0; }
</style>
