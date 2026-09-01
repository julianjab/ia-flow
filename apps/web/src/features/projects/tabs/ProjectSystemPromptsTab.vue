<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { SystemPromptDef } from '@ia-flow/shared';
import EditableCard from '@/ui/EditableCard.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import ScopeGroup from '@/ui/ScopeGroup.vue';
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
/** El abierto es heredado: se lee entero, no se guarda. */
const expandedIsGlobal = ref(false);
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
  expandedIsGlobal.value = false;
  spNewOpen.value = true;
}

/**
 * Abre (o cierra) el detalle de un prompt.
 *
 * Los globales usan el MISMO formulario, en lectura: hasta ahora sólo mostraban
 * los primeros 120 caracteres y no había forma de leer el texto entero sin
 * irse a General — y el texto ES el prompt. `isGlobal` decide si se ofrece
 * guardar, no si se puede mirar.
 */
function toggleExpandSp(sp: SystemPromptDef, isGlobal = false) {
  if (expandedSpId.value === sp.id) {
    expandedSpId.value = null;
    return;
  }
  spEditDraft.value = { name: sp.name, text: sp.text };
  expandedSpId.value = sp.id;
  expandedIsGlobal.value = isGlobal;
  spNewOpen.value = false;
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
  <section class="settings-section">
    <div class="section-header">
      <div class="section-head-text">
        <h2>System Prompts</h2>
        <p class="section-desc">
          Prompts base que los agentes de este proyecto pueden referenciar. Los globales se
          aplican igual acá; para modificarlos, editalos desde General.
        </p>
      </div>
      <div class="section-head-actions">
        <button type="button" class="btn btn--primary" @click="openNewSp">+ Agregar</button>
      </div>
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
    <ScopeGroup v-if="ownPrompts.length" variant="own" label="Del proyecto" :count="ownPrompts.length">
      <div class="pspt-list">
        <template v-for="sp in ownPrompts" :key="`own-${sp.id}`">
          <!-- Sin ✕ en la fila: borrar vive en el formulario que abre el click. -->
          <EditableCard
            v-if="expandedSpId !== sp.id"
            :clickable="true"
            @edit="toggleExpandSp(sp)"
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
            @delete="askConfirm({
              title: 'Eliminar system prompt',
              message: `¿Eliminar '${sp.name}'? Solo se quita de este proyecto.`,
              confirmLabel: 'Eliminar',
              onConfirm: async () => { await deleteSp(sp.id); expandedSpId = null },
            })"
          />
        </template>
      </div>
    </ScopeGroup>

    <!-- Globales: mismo gesto que los propios —la fila abre el detalle— pero el
         formulario viene deshabilitado. Antes eran una tarjeta muerta con 120
         caracteres de preview, así que leer el prompt entero obligaba a irse a
         General; y el texto ES el prompt. -->
    <ScopeGroup
      v-if="globalPrompts.length"
      variant="inherited"
      label="Globales"
      :count="globalPrompts.length"
      edit-hint="General → System Prompts"
    >
      <div class="pspt-list">
        <template v-for="sp in globalPrompts" :key="`global-${sp.id}`">
          <EditableCard
            v-if="expandedSpId !== sp.id"
            clickable
            muted
            @edit="toggleExpandSp(sp, true)"
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
            readonly
            :available-system-prompts="availablePrompts"
            @cancel="expandedSpId = null"
          />
        </template>
      </div>
    </ScopeGroup>

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
/* La caja, el encabezado y el botón salen de `theme.css` (`.settings-section`,
   `.section-header`, `.btn`): esta pantalla tenía su propia copia con otro
   radio, otro padding y un botón en `--fg` que no existe en el sistema. */
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
.pspt-preview { margin: 0.35rem 0 0; color: var(--fg-dim); font-size: 0.85rem; }
</style>
