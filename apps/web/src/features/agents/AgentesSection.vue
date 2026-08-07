<script setup lang="ts">
import { ref } from 'vue';
import type { AgentDefinition, ProjectConfig } from '@ia-flow/shared';
import AgentEditorModal from '@/features/agents/AgentEditorModal.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useToastStore } from '@/stores/toast';

const projectConfigStore = useProjectConfigStore();
const toastStore = useToastStore();

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

async function handleAgentSave(agent: AgentDefinition) {
  const current = projectConfigStore.config ?? {};
  const agents = current.agents ?? [];
  const exists = agents.some((a) => a.id === agent.id);
  const updated: ProjectConfig = {
    ...current,
    agents: exists ? agents.map((a) => (a.id === agent.id ? agent : a)) : [...agents, agent],
  };
  try {
    await projectConfigStore.save(updated);
    agentModalOpen.value = false;
    toastStore.success(`Agente '${agent.id}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function deleteAgent(agentId: string) {
  const current = projectConfigStore.config;
  if (!current) return;
  const updated: ProjectConfig = {
    ...current,
    agents: (current.agents ?? []).filter((a) => a.id !== agentId),
  };
  try {
    await projectConfigStore.save(updated);
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
          Biblioteca de definiciones de agentes reutilizables. Cada agente tiene un id, provider,
          prompt y output. Son referenciados por id desde los statuses.
        </p>
      </div>
      <button type="button" class="btn-add-repo" @click="openNewAgent">+ Agregar agente</button>
    </div>

    <div v-if="!projectConfigStore.config?.agents?.length" class="repos-empty">
      No hay agentes definidos. Haz clic en "+ Agregar agente" para crear el primero.
    </div>

    <div v-else class="agent-list">
      <div
        v-for="agent in projectConfigStore.config!.agents"
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
          <template v-if="agent.variables && Object.keys(agent.variables).length">
            <span class="agent-detail-label">Variables</span>
            <span class="agent-detail-value">{{ Object.entries(agent.variables).map(([k,v]) => `${k}=${v}`).join(', ') }}</span>
          </template>
        </div>
      </div>
    </div>
  </section>

  <AgentEditorModal
    :open="agentModalOpen"
    :agent="editingAgent"
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
.agent-card-top { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.agent-id-row { display: flex; align-items: center; gap: 0.5rem; flex: 1; }
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
