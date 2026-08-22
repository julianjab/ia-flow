<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, onMounted, ref, watch } from 'vue';
import type { AgentDefinition } from '@ia-flow/shared';
import AgentCard from '@/features/agents/AgentCard.vue';
import AgentEditorModal from '@/features/agents/AgentEditorModal.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useGlobalConfigStore } from '@/features/project-config/globalStore';
import { useProjectsStore } from '@/features/projects/store';
import { fetchAvailableAgents, fetchAvailableSystemPrompts } from '@/features/projects/availableApi';
import {
  createAgent as apiCreateAgent,
  deleteAgent as apiDeleteAgent,
  reorderAgents as apiReorderAgents,
  updateAgent as apiUpdateAgent,
  type Scope,
} from '@/features/project-config/crudApi';
import type { SystemPromptDef } from '@ia-flow/shared';
import { useToastStore } from '@/stores/toast';

function byPosition(a: AgentDefinition, b: AgentDefinition): number {
  return (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER);
}

function isEnabled(agent: AgentDefinition): boolean {
  return agent.enabled !== false;
}

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

// Orden aplicado localmente mientras el reorder viaja al server, para que
// soltar una tarjeta se vea instantáneo en vez de esperar el refetch. Se
// limpia cuando los datos frescos ya reflejan el mismo orden.
const orderOverride = ref<string[] | null>(null);

function applyOverride(list: AgentDefinition[]): AgentDefinition[] {
  const override = orderOverride.value;
  if (!override) return list;
  const rank = new Map(override.map((id, i) => [id, i]));
  return list
    .slice()
    .sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
}

const globalAgents = computed(() =>
  isProject.value
    ? availableAgents.value.filter((a) => a.projectId == null).sort(byPosition)
    : []
);
const globalEnabled = computed(() => globalAgents.value.filter(isEnabled));
const globalDisabled = computed(() => globalAgents.value.filter((a) => !isEnabled(a)));

// Lista editable en este scope: los agentes propios del proyecto, o los
// globales cuando estamos en la vista General.
const ownAgents = computed(() =>
  applyOverride(
    (isProject.value
      ? availableAgents.value.filter((a) => a.projectId != null)
      : configStore.value.config?.agents ?? []
    )
      .slice()
      .sort(byPosition),
  ),
);
const ownEnabled = computed(() => ownAgents.value.filter(isEnabled));
const ownDisabled = computed(() => ownAgents.value.filter((a) => !isEnabled(a)));
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

async function refresh() {
  await configStore.value.fetch();
  if (isProject.value) await loadAvailable();
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
    await refresh();
    agentModalOpen.value = false;
    toastStore.success(`Agente '${agent.id}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  }
}

async function deleteAgent(agentId: string) {
  const scope = currentScope();
  if (!scope) return;
  try {
    await apiDeleteAgent(scope, agentId);
    await refresh();
    toastStore.success(`Agente '${agentId}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  }
}

// `setPositions` asigna position = índice dentro de la lista que se manda,
// así que hay que mandar SIEMPRE el scope completo: si sólo mandáramos los
// habilitados, los deshabilitados quedarían con posiciones viejas que se
// intercalan con las nuevas y reaparecerían al frente al re-habilitarlos.
// Los deshabilitados van al final, que es donde la UI los muestra.
async function persistOrder(enabled: AgentDefinition[], disabled: AgentDefinition[]) {
  const scope = currentScope();
  if (!scope) return;
  const ids = [...enabled, ...disabled].map((a) => a.id);
  orderOverride.value = ids;
  try {
    await apiReorderAgents(scope, ids);
    await refresh();
  } catch (e) {
    toastStore.error(`Error al reordenar: ${extractErrorMessage(e)}`);
  } finally {
    orderOverride.value = null;
  }
}

// Reordering only applies to the enabled list — un agente deshabilitado no
// participa de la selección, así que su orden relativo no significa nada.
async function moveAgent(index: number, direction: -1 | 1) {
  const target = index + direction;
  if (target < 0 || target >= ownEnabled.value.length) return;
  const reordered = ownEnabled.value.slice();
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  await persistOrder(reordered, ownDisabled.value);
}

async function toggleEnabled(agent: AgentDefinition) {
  const scope = currentScope();
  if (!scope) return;
  const next = { ...agent, enabled: !isEnabled(agent) };
  try {
    await apiUpdateAgent(scope, next);
    // Reordena para que el agente caiga en el grupo correcto: habilitar lo
    // manda al final de los activos; deshabilitar, al final del scope.
    const rest = ownAgents.value.filter((a) => a.id !== agent.id);
    const enabled = rest.filter(isEnabled);
    const disabled = rest.filter((a) => !isEnabled(a));
    if (next.enabled) enabled.push(next);
    else disabled.push(next);
    await persistOrder(enabled, disabled);
    toastStore.success(
      `Agente '${agent.id}' ${next.enabled ? 'habilitado' : 'deshabilitado'}`,
    );
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  }
}

// ─── Drag & drop (HTML5 nativo, sin dependencias) ──────────────────────────
const dragIndex = ref<number | null>(null);
const dropIndex = ref<number | null>(null);

function onDragStart(index: number, event: DragEvent) {
  dragIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    // Firefox exige setData para iniciar el drag.
    event.dataTransfer.setData('text/plain', String(index));
  }
}

function onDragOver(index: number, event: DragEvent) {
  if (dragIndex.value === null) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropIndex.value = index;
}

async function onDrop(index: number) {
  const from = dragIndex.value;
  dragIndex.value = null;
  dropIndex.value = null;
  if (from === null || from === index) return;
  const reordered = ownEnabled.value.slice();
  const [moved] = reordered.splice(from, 1);
  reordered.splice(index, 0, moved);
  await persistOrder(reordered, ownDisabled.value);
}

function onDragEnd() {
  dragIndex.value = null;
  dropIndex.value = null;
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

function confirmDelete(agent: AgentDefinition) {
  askConfirm({
    title: 'Eliminar agente',
    message: isProject.value
      ? `¿Eliminar '${agent.id}'? Solo se quita de este proyecto.`
      : `¿Eliminar el agente '${agent.id}'? Esta acción no se puede deshacer.`,
    confirmLabel: 'Eliminar',
    onConfirm: () => deleteAgent(agent.id),
  });
}
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

    <p v-if="totalCount" class="order-hint">
      El orden importa: el engine ejecuta el primer agente <b>habilitado</b> cuyos criterios
      (repo · status · condiciones) hagan match con el issue.
      <b>Arrastra</b> una tarjeta para cambiar su prioridad.
    </p>

    <div v-if="!totalCount" class="repos-empty">
      <template v-if="isProject">
        No hay agentes disponibles. Crea uno con "+ Agregar agente del proyecto" o define
        globales desde General.
      </template>
      <template v-else>
        No hay agentes definidos. Haz clic en "+ Agregar agente" para crear el primero.
      </template>
    </div>

    <!-- Activos (editables en este scope) -->
    <div v-if="ownEnabled.length" class="agent-group">
      <h3 class="agent-group__title">
        {{ isProject ? 'Del proyecto · activos' : 'Activos' }}
        <span class="agent-group__hint">({{ ownEnabled.length }} · en orden de evaluación)</span>
      </h3>
      <div class="agent-list" data-kbd-list="agents">
        <AgentCard
          v-for="(agent, idx) in ownEnabled"
          :key="`own-${agent.id}`"
          :agent="agent"
          :order="idx + 1"
          :can-move-up="idx > 0"
          :can-move-down="idx < ownEnabled.length - 1"
          :dragging="dragIndex === idx"
          :drop-target="dropIndex === idx && dragIndex !== idx"
          data-kbd-item
          tabindex="0"
          draggable="true"
          @dragstart="onDragStart(idx, $event)"
          @dragover="onDragOver(idx, $event)"
          @drop.prevent="onDrop(idx)"
          @dragend="onDragEnd"
          @edit="openEditAgent(agent)"
          @toggle="toggleEnabled(agent)"
          @delete="confirmDelete(agent)"
          @move="(d) => moveAgent(idx, d)"
        />
      </div>
    </div>

    <!-- Deshabilitados: fuera de la selección del engine -->
    <div v-if="ownDisabled.length" class="agent-group agent-group--off">
      <h3 class="agent-group__title">
        Deshabilitados
        <span class="agent-group__hint">({{ ownDisabled.length }} · el engine nunca los elige)</span>
      </h3>
      <div class="agent-list" data-kbd-list="agents-disabled">
        <AgentCard
          v-for="agent in ownDisabled"
          :key="`off-${agent.id}`"
          :agent="agent"
          disabled
          data-kbd-item
          tabindex="0"
          @edit="openEditAgent(agent)"
          @toggle="toggleEnabled(agent)"
          @delete="confirmDelete(agent)"
        />
      </div>
    </div>

    <!-- scope=project: globales, read-only acá -->
    <template v-if="isProject">
      <div v-if="globalEnabled.length" class="agent-group">
        <h3 class="agent-group__title">
          Globales <span class="agent-group__hint">(read-only aquí)</span>
        </h3>
        <div class="agent-list">
          <AgentCard
            v-for="(agent, idx) in globalEnabled"
            :key="`global-${agent.id}`"
            :agent="agent"
            :order="idx + 1"
            readonly
            show-scope-badge
          />
        </div>
      </div>

      <div v-if="globalDisabled.length" class="agent-group agent-group--off">
        <h3 class="agent-group__title">
          Globales deshabilitados
          <span class="agent-group__hint">(read-only aquí)</span>
        </h3>
        <div class="agent-list">
          <AgentCard
            v-for="agent in globalDisabled"
            :key="`global-off-${agent.id}`"
            :agent="agent"
            readonly
            disabled
            show-scope-badge
          />
        </div>
      </div>
    </template>
  </section>

  <AgentEditorModal
    :open="agentModalOpen"
    :agent="editingAgent"
    :scope="props.scope"
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
.settings-section { border: 1px solid var(--border); padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: var(--fg-dim); line-height: 1.5; }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
.section-header h2 { margin: 0 0 0.2rem; font-size: 1.05rem; }

.btn-add-repo {
  flex-shrink: 0;
  padding: 0.35rem 0.8rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.btn-add-repo:hover { background: var(--accent); }

.repos-empty { font-size: 0.875rem; color: var(--fg-dim); padding: 0.5rem 0; }

.agent-group { margin-top: 0.75rem; }
.agent-group--off {
  margin-top: 1.1rem;
  padding-top: 0.75rem;
  border-top: 1px dashed var(--border-mute);
}
.agent-group__title {
  margin: 0 0 0.4rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--fg-mute);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.agent-group__hint {
  font-size: 0.7rem;
  color: var(--fg-dim);
  text-transform: none;
  font-weight: 400;
  letter-spacing: 0;
}

.agent-list { display: flex; flex-direction: column; gap: 0.6rem; }
.order-hint {
  margin: 0 0 0.6rem;
  font-size: var(--fs-body-sm);
  color: var(--fg-dim);
}
</style>
