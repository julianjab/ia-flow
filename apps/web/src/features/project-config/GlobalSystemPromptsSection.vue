<script setup lang="ts">
import { ref } from 'vue';
import type { SystemPromptDef } from '@ia-flow/shared';
import EditableCard from '@/ui/EditableCard.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import SystemPromptForm from '@/features/project-config/SystemPromptForm.vue';
import { useGlobalConfigStore } from '@/features/project-config/globalStore';
import {
  createSystemPrompt as apiCreateSystemPrompt,
  deleteSystemPrompt as apiDeleteSystemPrompt,
  updateSystemPrompt as apiUpdateSystemPrompt,
} from '@/features/project-config/crudApi';
import { useToastStore } from '@/stores/toast';

// Global-scope twin of the system prompt CRUD embedded in ProyectoSection.
// Kept as a separate component so /general/system-prompts doesn't drag in
// the whole project-config UI. If the CRUD grows, extract a shared child
// and mount it from both here and ProyectoSection.
const configStore = useGlobalConfigStore();
const toastStore = useToastStore();

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

async function saveSp() {
  const name = spDraft.value.name.trim();
  const text = spDraft.value.text.trim();
  if (!name || !text) return;
  const id = nameToId(name);
  await apiCreateSystemPrompt({ kind: 'global' }, { id, name, text });
  await configStore.fetch();
  spNewOpen.value = false;
  toastStore.success(`System prompt '${name}' guardado`);
}

async function saveSpEdit(sp: SystemPromptDef) {
  const name = spEditDraft.value.name.trim();
  const text = spEditDraft.value.text.trim();
  if (!name || !text) return;
  await apiUpdateSystemPrompt({ kind: 'global' }, { id: sp.id, name, text });
  await configStore.fetch();
  expandedSpId.value = null;
  toastStore.success(`System prompt '${name}' guardado`);
}

async function deleteSp(id: string) {
  await apiDeleteSystemPrompt({ kind: 'global' }, id);
  await configStore.fetch();
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
      <div>
        <p class="section-desc" style="margin: 0;">
          System prompts globales — disponibles en todos los proyectos.
        </p>
      </div>
      <button type="button" class="btn-add-repo" @click="openNewSp">+ Agregar</button>
    </div>

    <SystemPromptForm
      v-if="spNewOpen"
      v-model="spDraft"
      :id-hint="spDraft.name ? nameToId(spDraft.name) : ''"
      variant="new"
      :available-system-prompts="configStore.config?.systemPrompts ?? []"
      @save="saveSp"
      @cancel="spNewOpen = false"
    />

    <div v-if="!configStore.config?.systemPrompts?.length && !spNewOpen" class="repos-empty">
      No hay system prompts globales. Haz clic en "+ Agregar" para crear el primero.
    </div>

    <div v-else-if="configStore.config?.systemPrompts?.length" class="sp-list">
      <template v-for="sp in configStore.config.systemPrompts" :key="sp.id">
        <!-- Sin ✕ en la fila: borrar vive en el formulario que abre el click. -->
        <EditableCard
          v-if="expandedSpId !== sp.id"
          :clickable="true"
          @edit="toggleExpandSp(sp)"
        >
          <div class="sp-card-header">
            <code class="sp-id">{{ sp.id }}</code>
            <span class="sp-name">{{ sp.name }}</span>
          </div>
          <p class="sp-preview">{{ sp.text.slice(0, 120) }}{{ sp.text.length > 120 ? '…' : '' }}</p>
        </EditableCard>

        <SystemPromptForm
          v-else
          v-model="spEditDraft"
          :id-hint="sp.id"
          variant="edit"
          :available-system-prompts="configStore.config?.systemPrompts ?? []"
          @save="saveSpEdit(sp)"
          @cancel="expandedSpId = null"
          @delete="askConfirm({
            title: 'Eliminar system prompt',
            message: `¿Eliminar '${sp.name}'?`,
            confirmLabel: 'Eliminar',
            onConfirm: async () => { await deleteSp(sp.id); expandedSpId = null },
          })"
        />
      </template>
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
.settings-section {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1.25rem;
}
.section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.section-desc { color: var(--fg-dim); font-size: 0.9rem; }
.btn-add-repo {
  padding: 0.4rem 0.75rem;
  background: var(--fg);
  color: var(--panel);
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}
.repos-empty {
  padding: 1rem;
  color: var(--fg-dim);
  background: var(--panel-alt);
  border-radius: 6px;
  text-align: center;
}
.sp-list { display: flex; flex-direction: column; gap: 0.5rem; }
.sp-card-header { display: flex; gap: 0.5rem; align-items: baseline; }
.sp-id { background: var(--panel-hi); padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.75rem; }
.sp-name { font-weight: 600; }
.sp-preview { margin: 0.35rem 0 0; color: var(--fg-dim); font-size: 0.85rem; }

@media (max-width: 768px) {
  /* Un flex sin `wrap`: el botón de la derecha queda fuera de la pantalla y
     empuja la página. Envolver es lo correcto acá — es un encabezado, no una
     tabla cuyas columnas haya que alinear entre filas. */
  .sp-card-header { flex-wrap: wrap; row-gap: 0.35rem; }
  .sp-card-header > * { min-width: 0; }
  /* El nombre es un identificador sin espacios: sin `anywhere` su ancho
     mínimo empuja igual, aunque el contenedor envuelva. */
  .sp-card-header, .sp-card-header * { overflow-wrap: anywhere; }
}
</style>