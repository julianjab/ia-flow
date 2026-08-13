<script setup lang="ts">
import type { SourceRef } from '@ia-flow/shared';
import axios from 'axios';
import { computed, ref, watch } from 'vue';
import { useProjectsStore } from '@/features/projects/store';
import { useToastStore } from '@/stores/toast';
import SourceFormSwitch from '@/features/projects/sources/SourceFormSwitch.vue';

// Extracts the server-side { error } payload when present. Falls back to
// the axios/Error message so we never render an empty box.
function extractError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const data = e.response?.data as { error?: string; message?: string } | undefined;
    if (data?.error) return data.error;
    if (data?.message) return data.message;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'created', id: string): void }>();

const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const name = ref('');
const id = ref('');
const source = ref<SourceRef | null>({ kind: 'local', config: {} });
const idDirty = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

// Derive a slug from the name until the user edits the id manually.
function nameToSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

watch(name, (n) => {
  if (!idDirty.value) id.value = nameToSlug(n);
});

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      name.value = '';
      id.value = '';
      source.value = { kind: 'local', config: {} };
      idDirty.value = false;
      error.value = null;
    }
  },
);

const canSave = computed(() => name.value.trim() !== '' && id.value.trim() !== '');

async function submit() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = null;
  try {
    const project = await projectsStore.create({
      id: id.value.trim(),
      name: name.value.trim(),
      source: source.value ?? undefined,
    });
    toastStore.success(`Proyecto '${project.name}' creado`);
    emit('created', project.id);
    emit('close');
  } catch (e) {
    error.value = extractError(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="pc-modal-backdrop" @click.self="emit('close')">
    <div class="pc-modal" role="dialog" aria-modal="true" aria-labelledby="pc-modal-title">
      <header class="pc-modal__header">
        <h2 id="pc-modal-title">Nuevo proyecto</h2>
        <button class="pc-modal__close" @click="emit('close')" aria-label="Cerrar">×</button>
      </header>

      <div class="pc-modal__body">
        <label class="pc-field">
          <span class="pc-field__label">Nombre *</span>
          <input v-model="name" class="pc-input" placeholder="Mi proyecto" autofocus />
        </label>

        <label class="pc-field">
          <span class="pc-field__label">ID (slug) *</span>
          <input
            v-model="id"
            class="pc-input pc-input--mono"
            placeholder="mi-proyecto"
            @input="idDirty = true"
          />
          <span class="pc-field__hint">Identificador único, sin espacios (a-z, 0-9, -)</span>
        </label>

        <div class="pc-field">
          <SourceFormSwitch v-model="source" />
          <span class="pc-field__hint">
            El proveedor que gestiona los items del proyecto. Puedes cambiarlo después.
          </span>
        </div>

        <div v-if="error" class="pc-error">{{ error }}</div>
      </div>

      <footer class="pc-modal__footer">
        <button class="pc-btn pc-btn--ghost" @click="emit('close')" :disabled="saving">
          Cancelar
        </button>
        <button class="pc-btn pc-btn--primary" :disabled="!canSave || saving" @click="submit">
          {{ saving ? 'Creando…' : 'Crear proyecto' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.pc-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(17, 24, 39, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.pc-modal {
  background: var(--panel);
  border-radius: 12px;
  width: min(480px, 92vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 40px rgba(0,0,0,0.15);
}
.pc-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}
.pc-modal__header h2 { margin: 0; font-size: 1.15rem; }
.pc-modal__close {
  background: none;
  border: none;
  font-size: 1.4rem;
  color: var(--fg-dim);
  cursor: pointer;
  line-height: 1;
}
.pc-modal__body {
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
}
.pc-modal__footer {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  padding: 0.85rem 1.25rem;
  border-top: 1px solid var(--border);
}
.pc-field { display: flex; flex-direction: column; gap: 0.35rem; }
.pc-field__label { font-size: 0.85rem; font-weight: 500; color: var(--fg-mute); }
.pc-field__hint { font-size: 0.75rem; color: var(--fg-dim); }
.pc-input {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.9rem;
}
.pc-input--mono { font-family: ui-monospace, SFMono-Regular, monospace; }
.pc-btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
  border: 1px solid transparent;
}
.pc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.pc-btn--primary { background: var(--fg); color: var(--panel); }
.pc-btn--ghost { background: transparent; border-color: var(--border-hi); }
.pc-error {
  padding: 0.5rem 0.75rem;
  background: var(--red-bg);
  border: 1px solid var(--danger);
  color: var(--danger);
  border-radius: 6px;
  font-size: 0.85rem;
}
</style>
