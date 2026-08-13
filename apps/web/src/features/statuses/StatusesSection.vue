<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { StatusConfig } from '@ia-flow/shared';
import StatusConfigModal from '@/features/statuses/StatusConfigModal.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProjectsStore } from '@/features/projects/store';
import { useToastStore } from '@/stores/toast';
import { fetchAvailableAgents } from '@/features/projects/availableApi';
import {
  fetchProjectFields,
  fetchProjectStatuses,
  type SourceProjectField,
  type StatusOption,
} from '@/features/projects/sourceApi';
import {
  createStatus as apiCreateStatus,
  deleteStatus as apiDeleteStatus,
  updateStatus as apiUpdateStatus,
} from '@/features/statuses/statusesApi';
import type { AgentDefinition } from '@ia-flow/shared';

const projectConfigStore = useProjectConfigStore();
const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const statusModalOpen = ref(false);
const editingStatus = ref<StatusConfig | null>(null);
const sourceStatuses = ref<StatusOption[]>([]);
const sourceFields = ref<SourceProjectField[]>([]);
const statusNameLocked = ref(false);

// Union: globals + this project's own agents (server-side overlay). Falls back
// to the project store when no active project id yet so the modal isn't blank
// on first render.
const availableAgents = ref<AgentDefinition[]>([]);
const agentIds = computed(() => {
  if (availableAgents.value.length) return availableAgents.value.map((a) => a.id);
  return (projectConfigStore.config?.agents ?? []).map((a) => a.id);
});

// Status names come 100% from the project's source. The server-side factory
// picks the right ProjectSource per project kind (github, local, ...); the
// UI has no kind-specific branches. Config (agents + context) is looked up
// from the DB by name.
const allStatuses = computed(() => {
  const configMap = new Map(
    (projectConfigStore.config?.statuses ?? []).map((s) => [s.name.toLowerCase(), s]),
  );
  return sourceStatuses.value.map(({ name }) => ({
    name,
    config: configMap.get(name.toLowerCase()) ?? null,
  }));
});

const expandedAgents = ref(new Set<string>());
function toggleAgent(key: string, e: Event) {
  e.stopPropagation();
  if (expandedAgents.value.has(key)) expandedAgents.value.delete(key);
  else expandedAgents.value.add(key);
  expandedAgents.value = new Set(expandedAgents.value);
}

type WhenEntry = { field: string; op: string; value?: string; logic?: string };
function formatWhen(when: WhenEntry[] | Record<string, string> | undefined): string {
  if (!when) return '';
  if (Array.isArray(when)) {
    return when
      .map((c, i) => {
        const connector = i > 0 ? ` ${(c.logic ?? 'AND').toUpperCase()} ` : '';
        const val = c.op === '$null' ? 'nulo' : c.op === '$not_null' ? '≠ nulo' : c.op === '!=' ? `≠ ${c.value ?? ''}` : `= ${c.value ?? ''}`;
        return `${connector}${c.field} ${val}`;
      })
      .join('');
  }
  return Object.entries(when)
    .map(([k, v]) => {
      if (v === '$null') return `${k} nulo`;
      if (v === '$not_null') return `${k} ≠ nulo`;
      if (v.startsWith('$ne:')) return `${k} ≠ ${v.slice(4)}`;
      return `${k} = ${v}`;
    })
    .join(' AND ');
}

function formatOutcome(raw: string | undefined): string {
  if (!raw) return '';
  if (raw.startsWith('$set:')) {
    return raw
      .slice(5)
      .split(',')
      .map((pair) => {
        const eq = pair.indexOf('=');
        return eq >= 0 ? `${pair.slice(0, eq)}: ${pair.slice(eq + 1)}` : pair;
      })
      .join('  ·  ');
  }
  return raw;
}

function openConfigureStatus(name: string, config: StatusConfig | null) {
  editingStatus.value = config ?? ({ name, agents: [] } as StatusConfig);
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
    sourceFields.value = [];
    return;
  }
  try {
    const res = await fetchProjectStatuses(pid);
    sourceStatuses.value = res.statuses ?? [];
  } catch {
    sourceStatuses.value = [];
  }
  try {
    const res = await fetchProjectFields(pid);
    sourceFields.value = res.fields ?? [];
  } catch {
    sourceFields.value = [];
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

// Feed the modal the full field list from the project source. If the source
// couldn't return anything (offline, misconfigured, older provider), fall back
// to a synthetic Status field derived from getStatuses so the editor is never
// empty. `options` is normalised to string[] to match ProjectField.
const projectFieldsForModal = computed(() => {
  if (sourceFields.value.length) {
    return sourceFields.value.map((f) => ({
      name: f.name,
      dataType: f.dataType,
      options: f.options ?? [],
    }));
  }
  return [
    {
      name: 'Status',
      dataType: 'SINGLE_SELECT',
      options: sourceStatuses.value.map((s) => s.name),
    },
  ];
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
      Statuses activos en el proyecto. Haz clic en uno para ver o configurar su agente.
    </p>

    <div v-if="!allStatuses.length" class="repos-empty">
      No hay statuses aún. Crea una tarea primero.
    </div>

    <div v-else class="status-cards">
      <div
        v-for="{ name, config: sc } in allStatuses"
        :key="name"
        class="status-card"
        :class="{ 'status-card--configured': !!sc?.agents?.length }"
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
              message: `¿Eliminar la configuración del status '${name}'? Los agentes asignados se perderán.`,
              confirmLabel: 'Eliminar',
              onConfirm: () => deleteStatus(name),
            })"
          >✕</button>
        </div>

        <div v-if="sc?.agents?.length" class="status-card-body">
          <div
            v-for="(entry, i) in sc.agents"
            :key="i"
            class="sc-agent-card"
            @click.stop="toggleAgent(`${name}-${i}`, $event)"
          >
            <div class="sc-agent-row">
              <span class="sc-agent-chevron">{{ expandedAgents.has(`${name}-${i}`) ? '▾' : '▸' }}</span>
              <span class="sc-agent-name">{{ entry.agent }}</span>
              <span v-if="!entry.when" class="sc-default-badge">default</span>
              <span v-else class="sc-cond-summary">{{ formatWhen(entry.when) }}</span>
            </div>
            <div v-if="expandedAgents.has(`${name}-${i}`)" class="sc-agent-detail">
              <div v-if="entry.onProcess" class="sc-detail-row sc-detail-row--process">
                <span class="sc-detail-label">proceso</span>
                <span class="sc-detail-val">{{ formatOutcome(entry.onProcess) }}</span>
              </div>
              <div v-if="entry.onFinish" class="sc-detail-row sc-detail-row--finish">
                <span class="sc-detail-label">ok</span>
                <span class="sc-detail-val">{{ formatOutcome(entry.onFinish) }}</span>
              </div>
              <div v-if="entry.onError" class="sc-detail-row sc-detail-row--error">
                <span class="sc-detail-label">err</span>
                <span class="sc-detail-val">{{ formatOutcome(entry.onError) }}</span>
              </div>
              <div v-if="!entry.onProcess && !entry.onFinish && !entry.onError" class="sc-detail-empty">
                Sin transiciones
              </div>
            </div>
          </div>
        </div>

        <div v-else class="status-card-empty">
          <span>Sin agente configurado</span>
          <span class="sc-add-hint">+ Configurar</span>
        </div>
      </div>
    </div>
  </section>

  <StatusConfigModal
    :open="statusModalOpen"
    :status-config="editingStatus"
    :agent-ids="agentIds"
    :project-fields="projectFieldsForModal"
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
.settings-section { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: var(--fg-dim); line-height: 1.5; }

.repos-empty { font-size: 0.875rem; color: var(--fg-dim); padding: 0.5rem 0; }
.btn-delete {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--danger);
  border-radius: 5px;
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
  border-radius: 10px;
  padding: 0.85rem 1rem;
  background: var(--panel-alt);
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s, background 0.12s;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-height: 90px;
}
.status-card:hover { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.08); background: var(--panel); }
.status-card--configured { background: var(--panel); border-color: var(--border-hi); }
.status-card-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.status-card-name { font-size: 0.88rem; font-weight: 700; color: var(--fg); }
.status-card-body { display: flex; flex-direction: column; gap: 0.25rem; }
.status-card-empty { display: flex; flex-direction: column; gap: 0.2rem; flex: 1; justify-content: center; }
.status-card-empty > span:first-child { font-size: 0.75rem; color: var(--fg-dim); }
.sc-add-hint { font-size: 0.72rem; color: var(--accent); font-weight: 500; }

.sc-agent-card { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; cursor: pointer; transition: border-color 0.1s; }
.sc-agent-card:hover { border-color: var(--info); }
.sc-agent-row { display: flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.5rem; background: var(--panel-alt); }
.sc-agent-chevron { font-size: 0.6rem; color: #94a3b8; flex-shrink: 0; width: 0.65rem; }
.sc-agent-name { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.72rem; font-weight: 600; color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
.sc-cond-summary { font-size: 0.64rem; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.sc-default-badge { font-size: 0.62rem; background: var(--green-bg); color: var(--accent); padding: 0.05rem 0.35rem; border-radius: 4px; font-weight: 600; flex-shrink: 0; }
.sc-agent-detail { border-top: 1px solid var(--border); background: var(--panel); padding: 0.3rem 0.5rem; display: flex; flex-direction: column; gap: 0.2rem; }
.sc-detail-row { display: flex; align-items: baseline; gap: 0.4rem; font-size: 0.7rem; }
.sc-detail-label { flex-shrink: 0; font-weight: 600; font-size: 0.62rem; padding: 0.05rem 0.3rem; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.04em; }
.sc-detail-row--process .sc-detail-label { background: var(--yellow-bg); color: var(--warn); }
.sc-detail-row--finish  .sc-detail-label { background: var(--green-bg); color: var(--accent); }
.sc-detail-row--error   .sc-detail-label { background: var(--red-bg); color: var(--danger); }
.sc-detail-val { color: var(--fg-mute); font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-detail-empty { font-size: 0.68rem; color: var(--fg-dim); font-style: italic; }
</style>
