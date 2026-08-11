<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { AgentDefinition } from '@ia-flow/shared';
import AgentEditorModal from '@/features/agents/AgentEditorModal.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useGlobalConfigStore } from '@/features/project-config/globalStore';
import { useProjectsStore } from '@/features/projects/store';
import { fetchAvailableAgents, fetchAvailableSystemPrompts } from '@/features/projects/availableApi';
import {
  createAgent as apiCreateAgent,
  deleteAgent as apiDeleteAgent,
  updateAgent as apiUpdateAgent,
  type Scope,
} from '@/features/project-config/crudApi';
import type { SystemPromptDef } from '@ia-flow/shared';
import { useToastStore } from '@/stores/toast';

// scope='project' (default) → project detail view. Shows globals (read-only)
// + this project's own agents (editable). Writes always target the project.
// scope='global'  → General view. Only globals, editable.
const props = withDefaults(defineProps<{ scope?: 'project' | 'global' }>(), {
  scope: 'project',
});

const projectStore = useProjectConfigStore();
const globalStore = useGlobalConfigStore();
const projectsStore = useProjectsStore();
const configStore = computed(() => (props.scope === 'global' ? globalStore : projectStore));
const toastStore = useToastStore();

const isProject = computed(() => props.scope === 'project');

// When scope='project', we render two groups: read-only globals + editable
// project-owned. The union comes from /available-agents so the runtime
// overlay (project shadows global on id collision) is honoured.
const availableAgents = ref<AgentDefinition[]>([]);
// Sysprompt list handed to AgentEditorModal — overlay in project scope,
// globals only in global scope. Kept here so the modal doesn't need to know
// about the scope.
const availableSysprompts = ref<SystemPromptDef[]>([]);

async function loadAvailable() {
  if (!isProject.value) {
    availableAgents.value = [];
    availableSysprompts.value = globalStore.config?.systemPrompts ?? [];
    return;
  }
  const pid = projectsStore.activeProjectId;
  if (!pid) {
    availableAgents.value = [];
    availableSysprompts.value = [];
    return;
  }
  try {
    const [agents, prompts] = await Promise.all([
      fetchAvailableAgents(pid),
      fetchAvailableSystemPrompts(pid),
    ]);
    availableAgents.value = agents;
    availableSysprompts.value = prompts;
  } catch {
    availableAgents.value = [];
    availableSysprompts.value = [];
  }
}

onMounted(loadAvailable);
watch(() => [props.scope, projectsStore.activeProjectId], loadAvailable);
// Reload the overlay after any save so a new owned agent appears immediately.
watch(() => projectStore.config?.agents, () => { if (isProject.value) void loadAvailable(); });
// In global scope, keep the sysprompt list synced with the global store.
watch(() => globalStore.config?.systemPrompts, () => { if (!isProject.value) void loadAvailable(); });

const globalAgents = computed(() =>
  isProject.value ? availableAgents.value.filter((a) => a.projectId == null) : []
);
const ownAgents = computed(() =>
  isProject.value
    ? availableAgents.value.filter((a) => a.projectId != null)
    : configStore.value.config?.agents ?? []
);
const totalCount = computed(() => globalAgents.value.length + ownAgents.value.length);

const agentModalOpen = ref(false);
const editingAgent = ref<AgentDefinition | null>(null);

function openNewAgent() {
  editingAgent.value = null;
  agentModalOpen.value = true;
}
function openEditAgent(agent: AgentDefinition) {
  editingAgent.value = agent;
  agentModalOpen.value = true;
}

function currentScope(): Scope | null {
  if (!isProject.value) return { kind: 'global' };
  const pid = projectsStore.activeProjectId;
  return pid ? { kind: 'project', projectId: pid } : null;
}

function agentExistsInScope(id: string): boolean {
  if (isProject.value) return ownAgents.value.some((a) => a.id === id);
  return (configStore.value.config?.agents ?? []).some((a) => a.id === id);
}

async function handleAgentSave(agent: AgentDefinition) {
  const scope = currentScope();
  if (!scope) {
    toastStore.error('Selecciona un proyecto antes de guardar');
    return;
  }
  try {
    if (agentExistsInScope(agent.id)) {
      await apiUpdateAgent(scope, agent);
    } else {
      await apiCreateAgent(scope, agent);
    }
    await configStore.value.fetch();
    if (isProject.value) await loadAvailable();
    agentModalOpen.value = false;
    toastStore.success(`Agente '${agent.id}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function deleteAgent(agentId: string) {
  const scope = currentScope();
  if (!scope) return;
  try {
    await apiDeleteAgent(scope, agentId);
    await configStore.value.fetch();
    if (isProject.value) await loadAvailable();
    toastStore.success(`Agente '${agentId}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

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
    <div class="section-header">
      <div>
        <h2>Agentes</h2>
        <p class="section-desc" style="margin: 0.25rem 0 0;">
          <template v-if="isProject">
            Agentes disponibles para este proyecto. Los globales se muestran para referencia;
            para modificarlos, edítalos desde General.
          </template>
          <template v-else>
            Biblioteca de definiciones de agentes reutilizables. Cada agente tiene un id,
            provider, prompt y output. Son referenciados por id desde los statuses.
          </template>
        </p>
      </div>
      <button type="button" class="btn-add-repo" @click="openNewAgent">
        + Agregar agente {{ isProject ? 'del proyecto' : '' }}
      </button>
    </div>

    <div v-if="!totalCount && !isProject" class="repos-empty">
      No hay agentes definidos. Haz clic en "+ Agregar agente" para crear el primero.
    </div>

    <!-- scope=global: single flat list (all editable) -->
    <div v-if="!isProject" class="agent-list">
      <div
        v-for="agent in ownAgents"
        :key="agent.id"
        class="agent-card"
        @click="openEditAgent(agent)"
      >
        <div class="agent-card-top">
          <div class="agent-id-row">
            <code class="agent-id">{{ agent.id }}</code>
            <span class="agent-provider-badge">{{ agent.provider }}</span>
          </div>
          <div class="agent-actions">
            <button
              type="button"
              class="btn-delete"
              @click.stop="askConfirm({
                title: 'Eliminar agente',
                message: `¿Eliminar el agente '${agent.id}'? Esta acción no se puede deshacer.`,
                confirmLabel: 'Eliminar',
                onConfirm: () => deleteAgent(agent.id),
              })"
            >✕</button>
          </div>
        </div>
        <div class="agent-detail">
          <span class="agent-detail-label">Prompt</span>
          <code class="agent-detail-value">{{ agent.prompt.length > 80 ? agent.prompt.slice(0, 80) + '…' : agent.prompt }}</code>
        </div>
      </div>
    </div>

    <!-- scope=project: two sub-lists (globals read-only + own editable) -->
    <template v-else>
      <div v-if="ownAgents.length" class="agent-group">
        <h3 class="agent-group__title">Del proyecto</h3>
        <div class="agent-list">
          <div
            v-for="agent in ownAgents"
            :key="`own-${agent.id}`"
            class="agent-card"
            @click="openEditAgent(agent)"
          >
            <div class="agent-card-top">
              <div class="agent-id-row">
                <code class="agent-id">{{ agent.id }}</code>
                <span class="agent-provider-badge">{{ agent.provider }}</span>
              </div>
              <div class="agent-actions">
                <button
                  type="button"
                  class="btn-delete"
                  @click.stop="askConfirm({
                    title: 'Eliminar agente',
                    message: `¿Eliminar '${agent.id}'? Solo se quita de este proyecto.`,
                    confirmLabel: 'Eliminar',
                    onConfirm: () => deleteAgent(agent.id),
                  })"
                >✕</button>
              </div>
            </div>
            <div class="agent-detail">
              <span class="agent-detail-label">Prompt</span>
              <code class="agent-detail-value">{{ agent.prompt.length > 80 ? agent.prompt.slice(0, 80) + '…' : agent.prompt }}</code>
            </div>
          </div>
        </div>
      </div>

      <div v-if="globalAgents.length" class="agent-group">
        <h3 class="agent-group__title">
          Globales <span class="agent-group__hint">(read-only aquí)</span>
        </h3>
        <div class="agent-list">
          <div
            v-for="agent in globalAgents"
            :key="`global-${agent.id}`"
            class="agent-card agent-card--global"
          >
            <div class="agent-card-top">
              <div class="agent-id-row">
                <code class="agent-id">{{ agent.id }}</code>
                <span class="agent-provider-badge">{{ agent.provider }}</span>
                <span class="agent-scope-badge">global</span>
              </div>
            </div>
            <div class="agent-detail">
              <span class="agent-detail-label">Prompt</span>
              <code class="agent-detail-value">{{ agent.prompt.length > 80 ? agent.prompt.slice(0, 80) + '…' : agent.prompt }}</code>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!totalCount" class="repos-empty">
        No hay agentes disponibles. Crea uno con "+ Agregar agente del proyecto" o define
        globales desde General.
      </div>
    </template>
  </section>

  <AgentEditorModal
    :open="agentModalOpen"
    :agent="editingAgent"
    :available-system-prompts="availableSysprompts"
    @close="agentModalOpen = false"
    @save="handleAgentSave"
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
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
.section-header h2 { margin: 0 0 0.2rem; font-size: 1.05rem; }

.btn-add-repo {
  flex-shrink: 0;
  padding: 0.35rem 0.8rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.btn-add-repo:hover { background: #1d4ed8; }
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

.repos-empty { font-size: 0.875rem; color: #9ca3af; padding: 0.5rem 0; }

.agent-group { margin-top: 0.75rem; }
.agent-group__title {
  margin: 0 0 0.4rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: #374151;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.agent-group__hint {
  font-size: 0.7rem;
  color: #9ca3af;
  text-transform: none;
  font-weight: 400;
  letter-spacing: 0;
}

.agent-list { display: flex; flex-direction: column; gap: 0.6rem; }
.agent-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 0.75rem 0.9rem;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s, background 0.12s;
}
.agent-card:hover { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.08); background: #fff; }
.agent-card--global {
  cursor: default;
  background: #f9fafb;
  opacity: 0.85;
}
.agent-card--global:hover {
  border-color: #e5e7eb;
  box-shadow: none;
  background: #f9fafb;
}
.agent-card-top { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.agent-id-row { display: flex; align-items: center; gap: 0.5rem; flex: 1; flex-wrap: wrap; }
.agent-id {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.85rem;
  font-weight: 600;
  color: #1e293b;
}
.agent-provider-badge {
  font-size: 0.68rem;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  background: #dbeafe;
  color: #1d4ed8;
  font-weight: 500;
}
.agent-scope-badge {
  font-size: 0.65rem;
  padding: 0.08rem 0.4rem;
  border-radius: 4px;
  background: #f3f4f6;
  color: #6b7280;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.agent-actions { display: flex; align-items: center; gap: 0.35rem; flex-shrink: 0; }
.agent-detail {
  display: grid;
  grid-template-columns: 5rem 1fr;
  gap: 0.15rem 0.5rem;
  font-size: 0.78rem;
  align-items: baseline;
}
.agent-detail-label { color: #9ca3af; }
.agent-detail-value {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  color: #1e293b;
  word-break: break-all;
}
</style>
