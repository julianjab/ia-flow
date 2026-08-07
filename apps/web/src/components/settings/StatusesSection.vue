<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ProjectConfig, StatusConfig } from '@ia-flow/shared';
import StatusConfigModal from '../StatusConfigModal.vue';
import ConfirmDialog from '../ui/ConfirmDialog.vue';
import { useProjectConfigStore } from '../../stores/project-config';
import { useToastStore } from '../../stores/toast';
import { fetchTaskStatuses } from '../../api/project-config';
import { getProjectMeta, type ProjectField } from '../../api/github';

const projectConfigStore = useProjectConfigStore();
const toastStore = useToastStore();

const statusModalOpen = ref(false);
const editingStatus = ref<StatusConfig | null>(null);
const projectFields = ref<ProjectField[]>([]);
const taskStatusDirs = ref<string[]>([]);
const statusNameLocked = ref(false);

const agentIds = computed(() => (projectConfigStore.config?.agents ?? []).map((a) => a.id));

const allStatuses = computed(() => {
  const configMap = new Map((projectConfigStore.config?.statuses ?? []).map((s) => [s.name.toLowerCase(), s]));
  const githubStatusField = projectFields.value.find((f) => f.name.toLowerCase() === 'status');
  const githubOptions: string[] = githubStatusField?.options ?? [];
  const covered = new Set(githubOptions.map((s) => s.toLowerCase()));
  const extraFromDirs = taskStatusDirs.value.filter((s) => !covered.has(s.toLowerCase()));
  return [...githubOptions, ...extraFromDirs].map((name) => ({
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
  const current = projectConfigStore.config;
  if (!current) return;
  const updated: ProjectConfig = {
    ...current,
    statuses: (current.statuses ?? []).filter((s) => s.name !== statusName),
  };
  try {
    await projectConfigStore.save(updated);
    toastStore.success(`Status '${statusName}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function handleStatusSave(status: StatusConfig) {
  const current = projectConfigStore.config ?? {};
  const statuses = current.statuses ?? [];
  const exists = statuses.some((s) => s.name.toLowerCase() === status.name.toLowerCase());
  const updated: ProjectConfig = {
    ...current,
    statuses: exists
      ? statuses.map((s) => (s.name.toLowerCase() === status.name.toLowerCase() ? status : s))
      : [...statuses, status],
  };
  try {
    await projectConfigStore.save(updated);
    statusModalOpen.value = false;
    toastStore.success(`Status '${status.name}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function loadProjectFields() {
  try {
    const res = await getProjectMeta();
    projectFields.value = res.fields ?? [];
  } catch {
    projectFields.value = [];
  }
}

onMounted(async () => {
  void loadProjectFields();
  try {
    taskStatusDirs.value = await fetchTaskStatuses();
  } catch {
    /* non-critical */
  }
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
    :project-fields="projectFields"
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
.settings-section { border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: #6b7280; line-height: 1.5; }

.repos-empty { font-size: 0.875rem; color: #9ca3af; padding: 0.5rem 0; }
.btn-delete {
  padding: 0.3rem 0.5rem;
  border: 1px solid #fca5a5;
  border-radius: 5px;
  background: #fff;
  color: #ef4444;
  font-size: 0.8rem;
  cursor: pointer;
  line-height: 1;
}
.btn-delete:hover { background: #fef2f2; }

.status-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-top: 0.25rem; }
.status-card {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  background: #fafafa;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s, background 0.12s;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-height: 90px;
}
.status-card:hover { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.08); background: #fff; }
.status-card--configured { background: #fff; border-color: #d1d5db; }
.status-card-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.status-card-name { font-size: 0.88rem; font-weight: 700; color: #1e293b; }
.status-card-body { display: flex; flex-direction: column; gap: 0.25rem; }
.status-card-empty { display: flex; flex-direction: column; gap: 0.2rem; flex: 1; justify-content: center; }
.status-card-empty > span:first-child { font-size: 0.75rem; color: #9ca3af; }
.sc-add-hint { font-size: 0.72rem; color: #2563eb; font-weight: 500; }

.sc-agent-card { border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; cursor: pointer; transition: border-color 0.1s; }
.sc-agent-card:hover { border-color: #a5b4fc; }
.sc-agent-row { display: flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.5rem; background: #f8fafc; }
.sc-agent-chevron { font-size: 0.6rem; color: #94a3b8; flex-shrink: 0; width: 0.65rem; }
.sc-agent-name { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.72rem; font-weight: 600; color: #1e40af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
.sc-cond-summary { font-size: 0.64rem; color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.sc-default-badge { font-size: 0.62rem; background: #d1fae5; color: #065f46; padding: 0.05rem 0.35rem; border-radius: 4px; font-weight: 600; flex-shrink: 0; }
.sc-agent-detail { border-top: 1px solid #e5e7eb; background: #fff; padding: 0.3rem 0.5rem; display: flex; flex-direction: column; gap: 0.2rem; }
.sc-detail-row { display: flex; align-items: baseline; gap: 0.4rem; font-size: 0.7rem; }
.sc-detail-label { flex-shrink: 0; font-weight: 600; font-size: 0.62rem; padding: 0.05rem 0.3rem; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.04em; }
.sc-detail-row--process .sc-detail-label { background: #fef3c7; color: #92400e; }
.sc-detail-row--finish  .sc-detail-label { background: #d1fae5; color: #065f46; }
.sc-detail-row--error   .sc-detail-label { background: #fee2e2; color: #991b1b; }
.sc-detail-val { color: #374151; font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-detail-empty { font-size: 0.68rem; color: #9ca3af; font-style: italic; }
</style>
