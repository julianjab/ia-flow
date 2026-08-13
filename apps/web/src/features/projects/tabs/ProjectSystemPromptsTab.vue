<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { SystemPromptDef } from '@ia-flow/shared';
import EditableCard from '@/ui/EditableCard.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import SystemPromptForm from '@/features/project-config/SystemPromptForm.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProjectsStore } from '@/features/projects/store';
import { fetchAvailableSystemPrompts } from '@/features/projects/availableApi';
import {
  createSystemPrompt as apiCreateSystemPrompt,
  deleteSystemPrompt as apiDeleteSystemPrompt,
  updateSystemPrompt as apiUpdateSystemPrompt,
  type Scope,
} from '@/features/project-config/crudApi';
import { useToastStore } from '@/stores/toast';

// Twin of AgentesSection[scope=project] for system prompts. Two sub-lists:
//   · Del proyecto — editable, deletable, saves via projectConfigStore
//   · Globales     — read-only, edit lives under General → System Prompts
const configStore = useProjectConfigStore();
const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const availablePrompts = ref<SystemPromptDef[]>([]);
const globalPrompts = computed(() => availablePrompts.value.filter((p) => p.projectId == null));
const ownPrompts = computed(() => availablePrompts.value.filter((p) => p.projectId != null));
const totalCount = computed(() => globalPrompts.value.length + ownPrompts.value.length);

async function loadAvailable() {
  const pid = projectsStore.activeProjectId;
  if (!pid) { availablePrompts.value = []; return; }
  try {
    availablePrompts.value = await fetchAvailableSystemPrompts(pid);
  } catch {
    availablePrompts.value = [];
  }
}

onMounted(loadAvailable);
watch(() => projectsStore.activeProjectId, loadAvailable);
watch(() => configStore.config?.systemPrompts, loadAvailable);

const expandedSpId = ref<string | null>(null);
const spNewOpen = ref(false);
const spDraft = ref<{ name: string; text: string }>({ name: '', text: '' });
const spEditDraft = ref<{ name: string; text: string }>({ name: '', text: '' });

function nameToId(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(' ')
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

function openNewSp() {
  spDraft.value = { name: '', text: '' };
  expandedSpId.value = null;
  spNewOpen.value = true;
}

function toggleExpandSp(sp: SystemPromptDef) {
  if (expandedSpId.value === sp.id) {
    expandedSpId.value = null;
  } else {
    spEditDraft.value = { name: sp.name, text: sp.text };
    expandedSpId.value = sp.id;
    spNewOpen.value = false;
  }
}

function currentScope(): Scope | null {
  const pid = projectsStore.activeProjectId;
  return pid ? { kind: 'project', projectId: pid } : null;
}

async function saveSp() {
  const scope = currentScope();
  if (!scope) return;
  const name = spDraft.value.name.trim();
  const text = spDraft.value.text.trim();
  if (!name || !text) return;
  const id = nameToId(name);
  await apiCreateSystemPrompt(scope, { id, name, text });
  await configStore.fetch();
  await loadAvailable();
  spNewOpen.value = false;
  toastStore.success(`System prompt '${name}' guardado`);
}

async function saveSpEdit(sp: SystemPromptDef) {
  const scope = currentScope();
  if (!scope) return;
  const name = spEditDraft.value.name.trim();
  const text = spEditDraft.value.text.trim();
  if (!name || !text) return;
  await apiUpdateSystemPrompt(scope, { id: sp.id, name, text });
  await configStore.fetch();
  await loadAvailable();
  expandedSpId.value = null;
  toastStore.success(`System prompt '${name}' guardado`);
}

async function deleteSp(id: string) {
  const scope = currentScope();
  if (!scope) return;
  await apiDeleteSystemPrompt(scope, id);
  await configStore.fetch();
  await loadAvailable();
  toastStore.success('System prompt eliminado');
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
  <section class="pspt-section">
    <div class="pspt-header">
      <p>
        System prompts disponibles para este proyecto. Los globales se muestran para referencia;
        para modificarlos, edítalos desde General.
      </p>
      <button class="pspt-btn" @click="openNewSp">+ Agregar del proyecto</button>
    </div>

    <SystemPromptForm
      v-if="spNewOpen"
      v-model="spDraft"
      :id-hint="spDraft.name ? nameToId(spDraft.name) : ''"
      variant="new"
      :available-system-prompts="availablePrompts"
      @save="saveSp"
      @cancel="spNewOpen = false"
    />

    <!-- Del proyecto (editable) -->
    <div v-if="ownPrompts.length" class="pspt-group">
      <h3 class="pspt-group__title">Del proyecto</h3>
      <div class="pspt-list">
        <template v-for="sp in ownPrompts" :key="`own-${sp.id}`">
          <EditableCard
            v-if="expandedSpId !== sp.id"
            :clickable="true"
            @edit="toggleExpandSp(sp)"
            @delete="askConfirm({
              title: 'Eliminar system prompt',
              message: `¿Eliminar '${sp.name}'? Solo se quita de este proyecto.`,
              confirmLabel: 'Eliminar',
              onConfirm: () => deleteSp(sp.id),
            })"
          >
            <div class="pspt-card-header">
              <code class="pspt-id">{{ sp.id }}</code>
              <span class="pspt-name">{{ sp.name }}</span>
            </div>
            <p class="pspt-preview">
              {{ sp.text.slice(0, 120) }}{{ sp.text.length > 120 ? '…' : '' }}
            </p>
          </EditableCard>

          <SystemPromptForm
            v-else
            v-model="spEditDraft"
            :id-hint="sp.id"
            variant="edit"
            :available-system-prompts="availablePrompts"
            @save="saveSpEdit(sp)"
            @cancel="expandedSpId = null"
          />
        </template>
      </div>
    </div>

    <!-- Globales (read-only) -->
    <div v-if="globalPrompts.length" class="pspt-group">
      <h3 class="pspt-group__title">
        Globales <span class="pspt-group__hint">(read-only aquí)</span>
      </h3>
      <div class="pspt-list">
        <div
          v-for="sp in globalPrompts"
          :key="`global-${sp.id}`"
          class="pspt-card pspt-card--global"
        >
          <div class="pspt-card-header">
            <code class="pspt-id">{{ sp.id }}</code>
            <span class="pspt-name">{{ sp.name }}</span>
            <span class="pspt-scope-badge">global</span>
          </div>
          <p class="pspt-preview">
            {{ sp.text.slice(0, 120) }}{{ sp.text.length > 120 ? '…' : '' }}
          </p>
        </div>
      </div>
    </div>

    <div v-if="!totalCount && !spNewOpen" class="pspt-empty">
      No hay system prompts disponibles. Crea uno con "+ Agregar del proyecto" o define
      globales desde General.
    </div>
  </section>

  <ConfirmDialog
    :open="pendingConfirm != null"
    :title="pendingConfirm?.title ?? ''"
    :message="pendingConfirm?.message ?? ''"
    :confirm-label="pendingConfirm?.confirmLabel"
    @confirm="runConfirm"
    @cancel="cancelConfirm"
  />
</template>

<style scoped>
.pspt-section {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1.25rem;
}
.pspt-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.pspt-header p { margin: 0; color: var(--fg-dim); font-size: 0.9rem; }
.pspt-btn {
  padding: 0.4rem 0.75rem;
  background: var(--fg);
  color: var(--panel);
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
  white-space: nowrap;
}
.pspt-empty {
  padding: 1rem;
  color: var(--fg-dim);
  background: var(--panel-alt);
  border-radius: 6px;
  text-align: center;
}
.pspt-group { margin-top: 0.75rem; }
.pspt-group__title {
  margin: 0 0 0.4rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--fg-mute);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.pspt-group__hint {
  font-size: 0.7rem;
  color: var(--fg-dim);
  text-transform: none;
  font-weight: 400;
  letter-spacing: 0;
}
.pspt-list { display: flex; flex-direction: column; gap: 0.5rem; }
.pspt-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.75rem 0.9rem;
  background: var(--panel-alt);
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.pspt-card--global { opacity: 0.85; }
.pspt-card-header { display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; }
.pspt-id { background: var(--panel-hi); padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.75rem; }
.pspt-name { font-weight: 600; }
.pspt-scope-badge {
  font-size: 0.65rem;
  padding: 0.08rem 0.4rem;
  border-radius: 4px;
  background: var(--panel-hi);
  color: var(--fg-dim);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.pspt-preview { margin: 0.35rem 0 0; color: var(--fg-dim); font-size: 0.85rem; }
</style>
