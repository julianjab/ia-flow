<script setup lang="ts">
// Central CRUD for the MCP catalog. Entries live in `mcp_catalog` and are
// referenced by id from agent definitions (see AgentEditorModal).
import { onMounted, reactive, ref } from 'vue';
import type { McpCatalogEntry, McpServerConfig } from '@ia-flow/shared';
import { McpCatalogEntrySchema } from '@ia-flow/shared';
import McpServersEditor from '@/features/providers/McpServersEditor.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import { useToastStore } from '@/stores/toast';
import {
  createMcpCatalogEntry,
  deleteMcpCatalogEntry,
  listMcpCatalog,
  updateMcpCatalogEntry,
} from './api';

const toastStore = useToastStore();

interface Draft {
  id: string;
  name: string;
  description: string;
  config: McpServerConfig | null;
}

const entries = ref<McpCatalogEntry[]>([]);
const loading = ref(false);
const editing = ref<string | null>(null); // id of the entry being edited, or 'new'
const draft = reactive<Draft>({ id: '', name: '', description: '', config: null });

async function load() {
  loading.value = true;
  try {
    entries.value = await listMcpCatalog();
  } catch (err) {
    toastStore.error(`No se pudo cargar el catálogo MCP: ${String(err)}`);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function startNew() {
  editing.value = 'new';
  draft.id = '';
  draft.name = '';
  draft.description = '';
  draft.config = { type: 'stdio', command: '' };
}

function startEdit(entry: McpCatalogEntry) {
  editing.value = entry.id;
  draft.id = entry.id;
  draft.name = entry.name;
  draft.description = entry.description ?? '';
  draft.config = entry.config;
}

function cancel() {
  editing.value = null;
}

// McpServersEditor emits a `McpServers` record — we only care about the first
// entry (single-server draft). The map key drives the entry's persisted id.
function onServersUpdate(servers: Record<string, McpServerConfig>) {
  const [firstName] = Object.keys(servers);
  if (!firstName) {
    draft.config = null;
    return;
  }
  if (editing.value === 'new' && !draft.id.trim()) draft.id = firstName;
  draft.config = servers[firstName];
}

async function save() {
  if (!draft.id.trim() || !draft.name.trim() || !draft.config) {
    toastStore.error('id, nombre y config son requeridos');
    return;
  }
  const payload: McpCatalogEntry = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    config: draft.config,
  };
  try {
    McpCatalogEntrySchema.parse(payload);
  } catch (err) {
    toastStore.error(`Config inválida: ${String(err)}`);
    return;
  }
  const isNew = editing.value === 'new';
  try {
    if (isNew) {
      await createMcpCatalogEntry(payload);
    } else {
      await updateMcpCatalogEntry(editing.value!, payload);
    }
    toastStore.success(isNew ? 'Entrada creada' : 'Entrada actualizada');
    editing.value = null;
    await load();
  } catch (err) {
    toastStore.error(`No se pudo guardar: ${String(err)}`);
  }
}

function remove(id: string) {
  pendingConfirm.value = {
    title: 'Eliminar entrada',
    message: `¿Eliminar la entrada '${id}'?`,
    confirmLabel: 'Eliminar',
    onConfirm: () => doRemove(id),
  };
}

async function doRemove(id: string) {
  try {
    await deleteMcpCatalogEntry(id);
    toastStore.success('Entrada eliminada');
    await load();
  } catch (err) {
    toastStore.error(`No se pudo eliminar: ${String(err)}`);
  }
}

// McpServersEditor works over a `McpServers` (record). Build a single-entry
// map so we can reuse the same UI for stdio/http editing.
function draftAsServersMap(): Record<string, McpServerConfig> {
  if (!draft.config) return {};
  const key = draft.id.trim() || 'server';
  return { [key]: draft.config };
}

/** Confirmación in-app en vez de `confirm()` nativo: los botones del nativo los
 *  pinta el sistema operativo en el idioma del DISPOSITIVO, así que en un
 *  teléfono en inglés el mensaje sale en español con "OK / Cancel" abajo. */
const pendingConfirm = ref<{
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
} | null>(null);

async function runConfirm() {
  const c = pendingConfirm.value;
  if (!c) return;
  pendingConfirm.value = null;
  await c.onConfirm();
}
</script>

<template>
  <section class="mcp-catalog">
    <header class="section-head">
      <div>
        <h2>Catálogo MCP</h2>
        <p class="hint">
          Servidores MCP reutilizables. Los agentes los referencian por id desde la sección de
          agentes. Los overrides inline en el providerConfig del agente tienen precedencia.
        </p>
      </div>
      <button type="button" class="btn-primary" @click="startNew">+ Nueva entrada</button>
    </header>

    <p v-if="loading" class="muted">Cargando…</p>

    <ul v-if="!loading && entries.length" class="entry-list">
      <li v-for="entry in entries" :key="entry.id" class="entry">
        <div class="entry-main">
          <div class="entry-head">
            <span class="entry-id">{{ entry.id }}</span>
            <span class="entry-name">{{ entry.name }}</span>
          </div>
          <p v-if="entry.description" class="entry-desc">{{ entry.description }}</p>
          <code class="entry-config">{{ JSON.stringify(entry.config) }}</code>
        </div>
        <div class="entry-actions">
          <button type="button" class="btn-secondary" @click="startEdit(entry)">Editar</button>
          <button type="button" class="btn-danger" @click="remove(entry.id)">Eliminar</button>
        </div>
      </li>
    </ul>
    <p v-else-if="!loading" class="muted">Sin entradas todavía.</p>

    <div v-if="editing" class="editor">
      <h3>{{ editing === 'new' ? 'Nueva entrada MCP' : `Editar '${editing}'` }}</h3>
      <label class="field">
        <span>ID</span>
        <input v-model="draft.id" :disabled="editing !== 'new'" placeholder="github-mcp" />
      </label>
      <label class="field">
        <span>Nombre</span>
        <input v-model="draft.name" placeholder="GitHub MCP" />
      </label>
      <label class="field">
        <span>Descripción</span>
        <input v-model="draft.description" placeholder="Opcional" />
      </label>
      <div class="field">
        <span>Config</span>
        <McpServersEditor
          :model-value="draftAsServersMap()"
          @update:model-value="onServersUpdate"
        />
      </div>
      <div class="editor-actions">
        <button type="button" class="btn-secondary" @click="cancel">Cancelar</button>
        <button type="button" class="btn-primary" @click="save">Guardar</button>
      </div>
    </div>
  </section>

    <ConfirmDialog
      :open="!!pendingConfirm"
      :title="pendingConfirm?.title"
      :message="pendingConfirm?.message ?? ''"
      :confirm-label="pendingConfirm?.confirmLabel"
      danger
      @confirm="runConfirm"
      @cancel="pendingConfirm = null"
    />

</template>

<style scoped>
.mcp-catalog { display: flex; flex-direction: column; gap: 1rem; }
.section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.section-head h2 { margin: 0; font-size: 1.1rem; }
.hint { margin: 0.25rem 0 0; color: var(--fg-dim); font-size: 0.85rem; }
.muted { color: var(--fg-dim); font-size: 0.85rem; }
.entry-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.entry {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-alt);
}
.entry-main { flex: 1; display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
.entry-head { display: flex; gap: 0.5rem; align-items: baseline; }
.entry-id { font-family: monospace; font-weight: 600; color: var(--info); }
.entry-name { font-weight: 500; color: var(--fg); }
.entry-desc { margin: 0; font-size: 0.8rem; color: var(--fg-mute); }
.entry-config {
  display: block;
  font-size: 0.72rem;
  color: var(--fg-dim);
  background: var(--panel-hi);
  padding: 0.35rem 0.5rem;
  border-radius: 4px;
  overflow-x: auto;
  white-space: pre;
}
.entry-actions { display: flex; flex-direction: column; gap: 0.35rem; }
.editor {
  border: 1px solid var(--border-hi);
  border-radius: 8px;
  padding: 1rem;
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.editor h3 { margin: 0; font-size: 1rem; }
.field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: var(--fg-mute); }
.field input {
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.85rem;
}
.field input:disabled { background: var(--panel-alt); color: var(--fg-dim); }
.editor-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
.btn-primary {
  padding: 0.4rem 0.9rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
}
.btn-primary:hover { background: var(--accent); }
.btn-secondary {
  padding: 0.4rem 0.8rem;
  background: var(--panel);
  color: var(--fg-mute);
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.8rem;
}
.btn-secondary:hover { background: var(--panel-alt); }
.btn-danger {
  padding: 0.4rem 0.8rem;
  background: var(--panel);
  color: var(--danger);
  border: 1px solid var(--danger);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.8rem;
}
.btn-danger:hover { background: var(--red-bg); }

@media (max-width: 768px) {
  /* Un flex sin `wrap`: el botón de la derecha queda fuera de la pantalla y
     empuja la página. Envolver es lo correcto acá — es un encabezado, no una
     tabla cuyas columnas haya que alinear entre filas. */
  .section-head { flex-wrap: wrap; row-gap: 0.35rem; }
  .section-head > * { min-width: 0; }
}
</style>