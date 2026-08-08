<script setup lang="ts">
import { ref } from 'vue';
import type { ProjectConfig, SystemPromptDef } from '@ia-flow/shared';
import EditableCard from '@/ui/EditableCard.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import SystemPromptForm from '@/features/project-config/SystemPromptForm.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useToastStore } from '@/stores/toast';

// Project-scoped twin of GlobalSystemPromptsSection. Same CRUD, different
// store (activeProjectId is set by ProjectDetailView on mount).
const configStore = useProjectConfigStore();
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
  const current = configStore.config ?? {};
  const existing = current.systemPrompts ?? [];
  await configStore.save({ ...current, systemPrompts: [...existing, { id, name, text }] });
  spNewOpen.value = false;
  toastStore.success(`System prompt '${name}' guardado`);
}

async function saveSpEdit(sp: SystemPromptDef) {
  const name = spEditDraft.value.name.trim();
  const text = spEditDraft.value.text.trim();
  if (!name || !text) return;
  const current = configStore.config ?? {};
  const existing = current.systemPrompts ?? [];
  await configStore.save({
    ...current,
    systemPrompts: existing.map((s) => (s.id === sp.id ? { id: sp.id, name, text } : s)),
  });
  expandedSpId.value = null;
  toastStore.success(`System prompt '${name}' guardado`);
}

async function deleteSp(id: string) {
  const current = configStore.config ?? {};
  const updated: ProjectConfig = {
    ...current,
    systemPrompts: (current.systemPrompts ?? []).filter((sp) => sp.id !== id),
  };
  await configStore.save(updated);
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
      <p>System prompts propios del proyecto.</p>
      <button class="pspt-btn" @click="openNewSp">+ Agregar</button>
    </div>

    <SystemPromptForm
      v-if="spNewOpen"
      v-model="spDraft"
      :id-hint="spDraft.name ? nameToId(spDraft.name) : ''"
      variant="new"
      @save="saveSp"
      @cancel="spNewOpen = false"
    />

    <div v-if="!configStore.config?.systemPrompts?.length && !spNewOpen" class="pspt-empty">
      Este proyecto no tiene system prompts propios.
    </div>

    <div v-else-if="configStore.config?.systemPrompts?.length" class="pspt-list">
      <template v-for="sp in configStore.config.systemPrompts" :key="sp.id">
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
          @save="saveSpEdit(sp)"
          @cancel="expandedSpId = null"
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
.pspt-section {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 1.25rem;
}
.pspt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.pspt-header p { margin: 0; color: #6b7280; font-size: 0.9rem; }
.pspt-btn {
  padding: 0.4rem 0.75rem;
  background: #111827;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}
.pspt-empty {
  padding: 1rem;
  color: #6b7280;
  background: #f9fafb;
  border-radius: 6px;
  text-align: center;
}
.pspt-list { display: flex; flex-direction: column; gap: 0.5rem; }
.pspt-card-header { display: flex; gap: 0.5rem; align-items: baseline; }
.pspt-id { background: #f3f4f6; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.75rem; }
.pspt-name { font-weight: 600; }
.pspt-preview { margin: 0.35rem 0 0; color: #6b7280; font-size: 0.85rem; }
</style>
