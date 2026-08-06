<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PromptEditor from '../components/PromptEditor.vue';
import type { VariableGroup } from '../components/PromptEditor.vue';
import { useProjectConfigStore } from '../stores/project-config';
import { useProvidersStore } from '../stores/providers';
import { useToastStore } from '../stores/toast';
import type { AgentDefinition, ProjectConfig } from '@ia-flow/shared';

interface KV { key: string; value: string }
interface ToolDef { name: string; description: string }

const route = useRoute();
const router = useRouter();
const projectConfigStore = useProjectConfigStore();
const providersStore = useProvidersStore();
const toastStore = useToastStore();

const isNew = computed(() => route.params.agentId === 'new');
const title = computed(() => isNew.value ? 'Nuevo agente' : `Editar agente — ${route.params.agentId}`);

// ─── Form state ───────────────────────────────────────────────────────────────

const agentId      = ref('');
const provider     = ref('anthropic-api');
const prompt       = ref('');
const variables    = ref<KV[]>([]);
const selectedTools = ref<string[]>([]);
const availableTools = ref<ToolDef[]>([]);
const saving       = ref(false);

const providers = computed(() => providersStore.providers);

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

onMounted(async () => {
  await Promise.all([
    projectConfigStore.load?.(),
    providersStore.load?.(),
  ].filter(Boolean));

  if (!isNew.value) {
    const id = Array.isArray(route.params.agentId) ? route.params.agentId[0] : route.params.agentId;
    const agent = projectConfigStore.config?.agents?.find(a => a.id === id);
    if (agent) {
      agentId.value       = agent.id;
      provider.value      = agent.provider;
      prompt.value        = agent.prompt;
      variables.value     = Object.entries(agent.variables ?? {}).map(([key, value]) => ({ key, value }));
      selectedTools.value = agent.tools ?? [];
    }
  } else {
    provider.value = providers.value[0]?.id ?? 'anthropic-api';
  }

  try {
    const res = await fetch(`${API_BASE}/api/tools`);
    if (res.ok) availableTools.value = await res.json();
  } catch { /* server may not be running */ }
});

// ─── Variable helpers ─────────────────────────────────────────────────────────

function addVariable() { variables.value.push({ key: '', value: '' }); }
function removeVariable(i: number) { variables.value.splice(i, 1); }
function kvToRecord(list: KV[]): Record<string, string> {
  return Object.fromEntries(list.filter(kv => kv.key).map(kv => [kv.key, kv.value]));
}

// ─── Tool toggle ──────────────────────────────────────────────────────────────

function toggleTool(name: string) {
  const idx = selectedTools.value.indexOf(name);
  if (idx === -1) selectedTools.value.push(name);
  else selectedTools.value.splice(idx, 1);
}

// ─── Validation ───────────────────────────────────────────────────────────────

const errors = ref<string[]>([]);

function validate(): boolean {
  errors.value = [];
  if (!agentId.value.trim()) errors.value.push('El id es requerido.');
  if (/\s/.test(agentId.value)) errors.value.push('El id no puede tener espacios.');
  if (!provider.value.trim()) errors.value.push('El provider es requerido.');
  if (!prompt.value.trim()) errors.value.push('El prompt es requerido.');
  return errors.value.length === 0;
}

// ─── Save ─────────────────────────────────────────────────────────────────────

function buildAgent(): AgentDefinition {
  const agent: AgentDefinition = {
    id: agentId.value.trim(),
    provider: provider.value,
    prompt: prompt.value,
  };
  const vars = kvToRecord(variables.value);
  if (Object.keys(vars).length) agent.variables = vars;
  if (selectedTools.value.length) agent.tools = [...selectedTools.value];
  return agent;
}

async function onSave() {
  if (!validate()) return;
  const agent = buildAgent();
  const current = projectConfigStore.config ?? {};
  const agents = current.agents ?? [];
  const exists = agents.some(a => a.id === agent.id);
  const updated: ProjectConfig = {
    ...current,
    agents: exists ? agents.map(a => a.id === agent.id ? agent : a) : [...agents, agent],
  };
  try {
    saving.value = true;
    await projectConfigStore.save(updated);
    toastStore.success(`Agente '${agent.id}' guardado`);
    router.push({ name: 'settings', params: { tab: 'agentes' } });
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

function onCancel() {
  router.push({ name: 'settings', params: { tab: 'agentes' } });
}

// ─── Variable groups ──────────────────────────────────────────────────────────

const AGENT_VARIABLE_GROUPS: VariableGroup[] = [
  {
    label: 'project',
    items: [
      { label: '{{project.name}}',                     value: '{{project.name}}',                     hint: 'Nombre del proyecto' },
      { label: '{{project.language}}',                 value: '{{project.language}}',                 hint: 'Idioma configurado (e.g. español)' },
      { label: '{{project.field_options.priority}}',   value: '{{project.field_options.priority}}',   hint: 'Opciones del campo Priority' },
      { label: '{{project.field_options.size}}',       value: '{{project.field_options.size}}',       hint: 'Opciones del campo Size' },
      { label: '{{project.field_options.task_type}}',  value: '{{project.field_options.task_type}}',  hint: 'Opciones del campo Task Type' },
      { label: '{{project.field_options.field_name}}', value: '{{project.field_options.field_name}}', hint: 'Reemplaza field_name con el nombre del campo' },
    ],
  },
  {
    label: 'task',
    items: [
      { label: '{{task.title}}',         value: '{{task.title}}',         hint: 'Título del issue' },
      { label: '{{task.description}}',   value: '{{task.description}}',   hint: 'Cuerpo del issue' },
      { label: '{{task.type}}',          value: '{{task.type}}',          hint: '"functional" | "technical"' },
      { label: '{{task.status}}',        value: '{{task.status}}',        hint: 'Status actual de la tarea' },
      { label: '{{task.repos}}',         value: '{{task.repos}}',         hint: 'Repos seleccionados (separados por coma)' },
      { label: '{{task.issueUrl}}',      value: '{{task.issueUrl}}',      hint: 'URL completa del issue de GitHub' },
      { label: '{{task.issueNumber}}',   value: '{{task.issueNumber}}',   hint: 'Número del issue' },
      { label: '{{task.sections.NAME}}', value: '{{task.sections.NAME}}', hint: 'Sección nombrada del output anterior' },
    ],
  },
  {
    label: 'context',
    items: [
      { label: '{{context.repos}}', value: '{{context.repos}}', hint: 'CLAUDE.md + árbol de repos' },
    ],
  },
  {
    label: 'variables',
    items: [
      { label: '{{variables.KEY}}', value: '{{variables.KEY}}', hint: 'Variable definida en el agente' },
    ],
  },
];
</script>

<template>
  <div class="editor-shell">

    <!-- ── Header ────────────────────────────────────────────────────────── -->
    <header class="editor-header">
      <button class="back-btn" @click="onCancel">← Agentes</button>
      <h2 class="editor-title">{{ title }}</h2>
    </header>

    <!-- ── Form ──────────────────────────────────────────────────────────── -->
    <main class="editor-body">

      <!-- Identity -->
      <div class="field">
        <span class="label">ID <span class="req">*</span></span>
        <span class="field-hint">Identificador único, sin espacios. Referenciado desde statuses.</span>
        <input v-model="agentId" class="input" placeholder="functional-refiner" :disabled="!isNew" />
      </div>

      <!-- Provider -->
      <div class="field">
        <span class="label">Provider <span class="req">*</span></span>
        <select v-model="provider" class="input select">
          <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name ?? p.id }}</option>
        </select>
      </div>

      <!-- Prompt -->
      <div class="field">
        <span class="label">Prompt <span class="req">*</span></span>
        <span class="field-hint">
          Ruta de archivo (<code>./prompts/mi-prompt.md</code>) o texto inline.
        </span>
        <PromptEditor v-model="prompt" :rows="12" :variable-groups="AGENT_VARIABLE_GROUPS" />
      </div>

      <!-- Variables -->
      <div class="field">
        <span class="label">Variables</span>
        <span class="field-hint">Disponibles en el prompt como <code v-pre>{{variables.key}}</code></span>
        <div class="kv-list">
          <div v-for="(kv, i) in variables" :key="i" class="kv-row">
            <input v-model="kv.key"   class="input kv-key"   placeholder="key" />
            <span class="kv-eq">=</span>
            <input v-model="kv.value" class="input kv-value" placeholder="value" />
            <button class="kv-remove" @click="removeVariable(i)">✕</button>
          </div>
          <button class="btn-add-kv" @click="addVariable">+ Variable</button>
        </div>
      </div>

      <!-- Tools -->
      <div class="field">
        <span class="label">Tools</span>
        <span class="field-hint">Herramientas disponibles. Sin selección = todas.</span>
        <div v-if="availableTools.length" class="tools-grid">
          <label
            v-for="tool in availableTools"
            :key="tool.name"
            class="tool-chip"
            :class="{ active: selectedTools.includes(tool.name) }"
            :title="tool.description"
            @click="toggleTool(tool.name)"
          >
            <span class="tool-check">{{ selectedTools.includes(tool.name) ? '✓' : '' }}</span>
            <span class="tool-name">{{ tool.name }}</span>
          </label>
        </div>
        <p v-else class="field-hint" style="font-style: italic;">Servidor no disponible — inicia el servidor para cargar tools.</p>
      </div>

      <!-- Errors -->
      <div v-if="errors.length" class="error-list">
        <p v-for="e in errors" :key="e">{{ e }}</p>
      </div>

    </main>

    <!-- ── Footer ─────────────────────────────────────────────────────────── -->
    <footer class="editor-footer">
      <button class="btn-cancel" @click="onCancel">Cancelar</button>
      <button class="btn-save" :disabled="saving" @click="onSave">
        {{ saving ? 'Guardando…' : 'Guardar agente' }}
      </button>
    </footer>

  </div>
</template>

<style scoped>
.editor-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f8fafc;
}

.editor-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 2rem;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
  position: sticky;
  top: 0;
  z-index: 10;
}

.back-btn {
  background: none;
  border: none;
  color: #6b7280;
  font-size: 0.875rem;
  cursor: pointer;
  padding: 0.3rem 0.5rem;
  border-radius: 5px;
  white-space: nowrap;
}
.back-btn:hover { background: #f3f4f6; color: #111; }

.editor-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: #111827;
}

.editor-body {
  flex: 1;
  max-width: 820px;
  width: 100%;
  margin: 0 auto;
  padding: 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.editor-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 1rem 2rem;
  background: #fff;
  border-top: 1px solid #e5e7eb;
  position: sticky;
  bottom: 0;
}

.field { display: flex; flex-direction: column; gap: 0.3rem; }
.label { font-size: 0.82rem; font-weight: 600; color: #374151; }
.req { color: #ef4444; }
.field-hint { font-size: 0.73rem; color: #9ca3af; line-height: 1.4; }
.field-hint code {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  background: #f3f4f6;
  padding: 0.05rem 0.25rem;
  border-radius: 3px;
}

.input {
  padding: 0.45rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.875rem;
  color: #1e293b;
  background: #fff;
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
.input:disabled { background: #f9fafb; color: #6b7280; cursor: not-allowed; }
.select { cursor: pointer; }

.kv-list { display: flex; flex-direction: column; gap: 0.35rem; }
.kv-row { display: flex; align-items: center; gap: 0.35rem; }
.kv-key { flex: 1 1 6rem; min-width: 0; }
.kv-value { flex: 2 1 10rem; min-width: 0; }
.kv-eq { color: #9ca3af; font-size: 0.85rem; flex-shrink: 0; }
.kv-remove {
  flex-shrink: 0;
  background: none;
  border: none;
  color: #ef4444;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0.1rem 0.3rem;
  opacity: 0.7;
}
.kv-remove:hover { opacity: 1; }
.btn-add-kv {
  align-self: flex-start;
  background: none;
  border: 1px dashed #d1d5db;
  border-radius: 5px;
  color: #6b7280;
  font-size: 0.78rem;
  padding: 0.25rem 0.65rem;
  cursor: pointer;
}
.btn-add-kv:hover { border-color: #2563eb; color: #2563eb; }

.tools-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.tool-chip {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.78rem;
  color: #374151;
  cursor: pointer;
  user-select: none;
  background: #fff;
  transition: border-color 0.1s, background 0.1s;
}
.tool-chip:hover { border-color: #6366f1; color: #4f46e5; }
.tool-chip.active { border-color: #6366f1; background: #eef2ff; color: #4f46e5; font-weight: 500; }
.tool-check { width: 0.8rem; font-size: 0.72rem; color: #6366f1; }
.tool-name { font-family: 'SF Mono', 'Fira Code', monospace; }

.error-list {
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
.error-list p { margin: 0.15rem 0; font-size: 0.8rem; color: #dc2626; }

.btn-cancel {
  padding: 0.45rem 1.1rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 0.875rem;
  cursor: pointer;
  color: #374151;
}
.btn-cancel:hover { background: #f9fafb; }
.btn-save {
  padding: 0.45rem 1.4rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-save:hover:not(:disabled) { background: #1d4ed8; }
.btn-save:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
