<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ProjectConfig, SystemPromptDef } from '@ia-flow/shared';
import EditableCard from '@/ui/EditableCard.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import SystemPromptForm from '@/features/project-config/SystemPromptForm.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useToastStore } from '@/stores/toast';

const projectConfigStore = useProjectConfigStore();
const toastStore = useToastStore();

const projectName = ref('');
const projectLanguage = ref('');
const saving = ref(false);

function hydrate() {
  const cfg = projectConfigStore.config;
  if (!cfg) return;
  projectName.value = cfg.project?.name ?? '';
  projectLanguage.value = cfg.project?.language ?? '';
}

hydrate();
watch(() => projectConfigStore.config, hydrate);

// ─── System Prompts CRUD ──────────────────────────────────────────────────
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
  const current = projectConfigStore.config ?? {};
  const existing = current.systemPrompts ?? [];
  await projectConfigStore.save({ ...current, systemPrompts: [...existing, { id, name, text }] });
  spNewOpen.value = false;
  toastStore.success(`System prompt '${name}' guardado`);
}

async function saveSpEdit(sp: SystemPromptDef) {
  const name = spEditDraft.value.name.trim();
  const text = spEditDraft.value.text.trim();
  if (!name || !text) return;
  const current = projectConfigStore.config ?? {};
  const existing = current.systemPrompts ?? [];
  await projectConfigStore.save({
    ...current,
    systemPrompts: existing.map((s) => (s.id === sp.id ? { id: sp.id, name, text } : s)),
  });
  expandedSpId.value = null;
  toastStore.success(`System prompt '${name}' guardado`);
}

async function deleteSp(id: string) {
  const current = projectConfigStore.config ?? {};
  const updated: ProjectConfig = {
    ...current,
    systemPrompts: (current.systemPrompts ?? []).filter((sp) => sp.id !== id),
  };
  await projectConfigStore.save(updated);
  toastStore.success('System prompt eliminado');
}

// ─── Confirm dialog local ──────────────────────────────────────────────────
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

// ─── Save ─────────────────────────────────────────────────────────────────
async function onSaveProyecto() {
  saving.value = true;
  try {
    const current = projectConfigStore.config ?? {};
    const updated: ProjectConfig = {
      ...current,
      project: { name: projectName.value, language: projectLanguage.value },
    };
    await projectConfigStore.save(updated);
    toastStore.success('Configuración guardada');
  } catch (e) {
    toastStore.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <!-- Project settings -->
  <section class="settings-section">
    <h2>Proyecto</h2>
    <p class="section-desc">Configuración general del proyecto.</p>
    <div class="grid-2">
      <label class="field">
        <span class="field-label">Nombre</span>
        <input v-model="projectName" class="input" placeholder="ia-flow" />
      </label>
      <label class="field">
        <span class="field-label">Idioma</span>
        <input v-model="projectLanguage" class="input" placeholder="español" />
      </label>
    </div>
  </section>

  <!-- System Prompts Library -->
  <section class="settings-section">
    <div class="section-header">
      <div>
        <h2>System Prompts</h2>
        <p class="section-desc" style="margin: 0.25rem 0 0;">
          Biblioteca de prompts de sistema reutilizables. Selecciónalos desde cada agente para inyectarlos en el contexto.
        </p>
      </div>
      <button type="button" class="btn-add-repo" @click="openNewSp">+ Agregar</button>
    </div>

    <SystemPromptForm
      v-if="spNewOpen"
      v-model="spDraft"
      :id-hint="spDraft.name ? nameToId(spDraft.name) : ''"
      variant="new"
      @save="saveSp"
      @cancel="spNewOpen = false"
    />

    <div v-if="!projectConfigStore.config?.systemPrompts?.length && !spNewOpen" class="repos-empty">
      No hay system prompts. Haz clic en "+ Agregar" para crear el primero.
    </div>

    <div v-else-if="projectConfigStore.config?.systemPrompts?.length" class="sp-list">
      <template v-for="sp in projectConfigStore.config.systemPrompts" :key="sp.id">
        <EditableCard
          v-if="expandedSpId !== sp.id"
          :clickable="true"
          @edit="toggleExpandSp(sp)"
          @delete="askConfirm({
            title: 'Eliminar system prompt',
            message: `¿Eliminar '${sp.name}'?`,
            confirmLabel: 'Eliminar',
            onConfirm: () => deleteSp(sp.id),
          })"
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
          @save="saveSpEdit(sp)"
          @cancel="expandedSpId = null"
        />
      </template>
    </div>
  </section>

  <!-- Save -->
  <footer class="settings-actions">
    <button
      type="button"
      class="save-button"
      :disabled="saving"
      data-testid="settings-save-button"
      @click="onSaveProyecto"
    >
      {{ saving ? 'Guardando…' : 'Guardar cambios' }}
    </button>
  </footer>

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

.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.65rem 1rem; }
.field { display: flex; flex-direction: column; gap: 0.25rem; }
.field-label { font-size: 0.8rem; font-weight: 500; color: #374151; }
.input {
  padding: 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.84rem;
  color: #1e293b;
  background: #fff;
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }

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

.repos-empty { font-size: 0.875rem; color: #9ca3af; padding: 0.5rem 0; }

.sp-list { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.25rem; }
.sp-card-header { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.25rem; }
.sp-id { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.75rem; color: #6366f1; background: #eef2ff; padding: 0.1rem 0.35rem; border-radius: 4px; }
.sp-name { font-size: 0.82rem; font-weight: 600; color: #111827; }
.sp-preview { margin: 0; font-size: 0.75rem; color: #6b7280; font-family: 'SF Mono', 'Fira Code', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.settings-actions { display: flex; justify-content: flex-end; }
.save-button {
  padding: 0.5rem 1.4rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  font-size: 0.95rem;
}
.save-button:hover { background: #1d4ed8; }
.save-button:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
