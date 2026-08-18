<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { AgentDefinition, StatusConfig } from '@ia-flow/shared';
import StatusConfigModal from '@/features/statuses/StatusConfigModal.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProjectsStore } from '@/features/projects/store';
import { useToastStore } from '@/stores/toast';
import { fetchAvailableAgents } from '@/features/projects/availableApi';
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

// Union: globals + this project's own agents (server-side overlay). A status
// no longer owns its agents (see StatusConfigSchema) — instead each agent
// declares its own `statusName`, so the list here is derived by filtering
// the project's agent pipeline, not read off the status config.
const availableAgents = ref<AgentDefinition[]>([]);

function agentsForStatus(statusName: string): AgentDefinition[] {
  return availableAgents.value
    .filter((a) => a.statusName?.toLowerCase() === statusName.toLowerCase())
    .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
}

// Status names come 100% from the project's source. The server-side factory
// picks the right ProjectSource per project kind (github, local, ...); the
// UI has no kind-specific branches. Config (allowBlocked, etc.) is looked up
// from the DB by name.
const allStatuses = computed(() => {
  const configMap = new Map(
    (projectConfigStore.config?.statuses ?? []).map((s) => [s.name.toLowerCase(), s]),
  );
  return sourceStatuses.value.map(({ name }) => ({
    name,
    config: configMap.get(name.toLowerCase()) ?? null,
    agents: agentsForStatus(name),
  }));
});

function openConfigureStatus(name: string, config: StatusConfig | null) {
  editingStatus.value = config ?? ({ name } as StatusConfig);
  statusNameLocked.value = true;
  statusModalOpen.value = true;
}

async function deleteStatus(statusName: string) {
  const pid = projectsStore.activeProjectId;
  if (!pid) return;
  try {
    await apiDeleteStatus(pid, statusName);
    await projectConfigStore.fetch();
    toastStore.success(`Status '${statusName}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
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
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
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

async function loadAvailableAgents() {
  const pid = projectsStore.activeProjectId;
  if (!pid) {
    availableAgents.value = [];
    return;
  }
  try {
    availableAgents.value = await fetchAvailableAgents(pid);
  } catch {
    availableAgents.value = [];
  }
}

onMounted(() => {
  void loadSourceStatuses();
  void loadAvailableAgents();
});

// Reload source-derived data whenever the user switches projects.
watch(() => projectsStore.activeProjectId, () => {
  void loadSourceStatuses();
  void loadAvailableAgents();
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
      Statuses activos en el proyecto. Los agentes que corren en cada uno se configuran desde
      su propio editor (Activación → Status) — acá se ven de sólo lectura, en el orden en que
      el engine los evalúa.
    </p>

    <div v-if="!allStatuses.length" class="repos-empty">
      No hay statuses aún. Crea una tarea primero.
    </div>

    <div v-else class="status-cards">
      <div
        v-for="{ name, config: sc, agents } in allStatuses"
        :key="name"
        class="status-card"
        :class="{ 'status-card--configured': !!agents.length }"
        @click="openConfigureStatus(name, sc)"
      >
        <div class="status-card-header">
          <span class="status-card-name">{{ name }}</span>
          <button
            v-if="sc"
            type="button"
            class="btn-delete"
            title="Eliminar configuración"
            @click.stop="askConfirm({
              title: 'Eliminar configuración de status',
              message: `¿Eliminar la configuración del status '${name}'?`,
              confirmLabel: 'Eliminar',
              onConfirm: () => deleteStatus(name),
            })"
          >✕</button>
        </div>

        <div v-if="agents.length" class="status-card-body">
          <router-link
            v-for="(agent, i) in agents"
            :key="agent.id"
            :to="{ name: 'projects.detail', params: { id: projectsStore.activeProjectId, tab: 'agentes' } }"
            class="sc-agent-row"
            :class="{ 'sc-agent-row--first': i === 0 }"
            :title="`Editar agente '${agent.id}' desde la pestaña Agentes`"
            @click.stop
          >
            <span class="sc-agent-order">{{ i === 0 ? '▸' : `#${i + 1}` }}</span>
            <span class="sc-agent-name">{{ agent.id }}</span>
            <span v-if="agent.enabled === false" class="sc-agent-off">deshabilitado</span>
            <span v-if="i === 0" class="sc-agent-hint">correría primero</span>
          </router-link>
        </div>

        <div v-else class="status-card-empty">
          <span>Sin agentes configurados</span>
          <span class="sc-add-hint">+ Configurar status</span>
        </div>
      </div>
    </div>
  </section>

  <StatusConfigModal
    :open="statusModalOpen"
    :status-config="editingStatus"
    :status-options="sourceStatuses.map((s) => s.name)"
    :name-locked="statusNameLocked"
    @close="statusModalOpen = false"
    @save="handleStatusSave"
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

.repos-empty { font-size: 0.875rem; color: var(--fg-dim); padding: 0.5rem 0; }
.btn-delete {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--danger);
  background: var(--panel);
  color: var(--danger);
  font-size: 0.8rem;
  cursor: pointer;
  line-height: 1;
}
.btn-delete:hover { background: var(--red-bg); }

.status-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-top: 0.25rem; }
.status-card {
  border: 1px solid var(--border);
  padding: 0.85rem 1rem;
  background: var(--panel-alt);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-height: 90px;
}
.status-card:hover { border-color: var(--accent); background: var(--panel); }
.status-card--configured { background: var(--panel); border-color: var(--border-hi); }
.status-card-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.status-card-name { font-size: 0.88rem; font-weight: 700; color: var(--fg); }
.status-card-body { display: flex; flex-direction: column; gap: 0.2rem; }
.status-card-empty { display: flex; flex-direction: column; gap: 0.2rem; flex: 1; justify-content: center; }
.status-card-empty > span:first-child { font-size: 0.75rem; color: var(--fg-dim); }
.sc-add-hint { font-size: 0.72rem; color: var(--accent); font-weight: 500; }

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
