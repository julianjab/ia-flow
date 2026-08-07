<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PromptField from '@/features/prompts/PromptField.vue';
import type { VariableGroup, KV } from '@/features/prompts/PromptField.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProvidersStore } from '@/features/providers/store';
import { useToastStore } from '@/stores/toast';
import type { AgentDefinition, AgentVariableValue, ProjectConfig, SystemPromptDef, VariableDefinition } from '@ia-flow/shared';
import { formatVariable } from '@ia-flow/shared';

interface ToolDef { name: string; description: string }

const route = useRoute();
const router = useRouter();
const projectConfigStore = useProjectConfigStore();
const providersStore = useProvidersStore();
const toastStore = useToastStore();

const isNew = computed(() => route.params.agentId === 'new');
const title = computed(() => isNew.value ? 'Nuevo agente' : `Editar agente — ${route.params.agentId}`);

// ─── Form state ───────────────────────────────────────────────────────────────

const agentId           = ref('');
const provider          = ref('anthropic-api');
const prompt            = ref('');
const variables         = ref<KV[]>([]);
const selectedTools      = ref<string[]>([]);
const selectedSysprompts = ref<string[]>([]);
const availableTools    = ref<ToolDef[]>([]);
const saving            = ref(false);

const availableSysprompts = computed<SystemPromptDef[]>(
  () => projectConfigStore.config?.systemPrompts ?? []
)


function toggleSysprompt(id: string) {
  const idx = selectedSysprompts.value.indexOf(id)
  if (idx === -1) selectedSysprompts.value.push(id)
  else selectedSysprompts.value.splice(idx, 1)
}

const providers = computed(() => providersStore.providers);

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

onMounted(async () => {
  const loads: Promise<unknown>[] = [];
  if (!projectConfigStore.config) loads.push(projectConfigStore.fetch());
  if (!providersStore.providers.length) loads.push(providersStore.fetchConfig());
  await Promise.all(loads);

  if (!isNew.value) {
    const id = Array.isArray(route.params.agentId) ? route.params.agentId[0] : route.params.agentId;
    const agent = projectConfigStore.config?.agents?.find(a => a.id === id);
    if (agent) {
      agentId.value       = agent.id;
      provider.value      = agent.provider;
      prompt.value        = agent.prompt;
      variables.value          = Object.entries(agent.variables ?? {}).map(([key, value]) => ({ key, value: agentVarToString(value) }));
      selectedTools.value      = agent.tools ?? [];
      selectedSysprompts.value = agent.systemPrompts ?? [];
    }
  } else {
    provider.value = providers.value[0]?.id ?? 'anthropic-api';
  }

  await Promise.all([
    fetch(`${API_BASE}/api/tools`).then(r => r.ok ? r.json() : []).then(d => { availableTools.value = d }).catch(() => {}),
    fetchVariableGroups(),
  ]);
});

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
  if (selectedSysprompts.value.length) agent.systemPrompts = [...selectedSysprompts.value];
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
// Fetched from /api/variables?context=agent-prompt at runtime.

const agentVariableGroups = ref<VariableGroup[]>([]);

function buildGroupsFromDefs(defs: VariableDefinition[]): VariableGroup[] {
  const byGroup = new Map<string, VariableDefinition[]>();
  for (const v of defs) {
    const g = v.group ?? 'other';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(v);
  }
  const order = ['project', 'task', 'context', 'custom', 'github', 'system', 'other'];
  return [...byGroup.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([label, items]) => ({
      label,
      items: items.map(v => {
        const formatted = formatVariable(v);
        return { label: formatted, value: formatted, hint: v.description };
      }),
    }));
}

async function fetchVariableGroups() {
  try {
    const res = await fetch(`${API_BASE}/api/variables?context=agent-prompt`);
    if (res.ok) {
      const defs: VariableDefinition[] = await res.json();
      agentVariableGroups.value = buildGroupsFromDefs(defs);
    }
  } catch { /* server may not be running */ }
}

// ─── Normalize agent variable value for the KV list ──────────────────────────

function agentVarToString(v: AgentVariableValue): string {
  return typeof v === 'string' ? v : v.value;
}
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

      <!-- System Prompts -->
      <div v-if="availableSysprompts.length" class="field">
        <span class="label">System Prompts</span>
        <span class="field-hint">Selecciona los system prompts que se enviarán al modelo. Sin selección = ninguno extra.</span>
        <div class="sp-chips">
          <label
            v-for="sp in availableSysprompts"
            :key="sp.id"
            class="sp-chip"
            :class="{ active: selectedSysprompts.includes(sp.id) }"
            :title="sp.text"
            @click="toggleSysprompt(sp.id)"
          >
            <span class="sp-check">{{ selectedSysprompts.includes(sp.id) ? '✓' : '' }}</span>
            <span class="sp-chip-name">{{ sp.name }}</span>
          </label>
        </div>
      </div>

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

      <!-- Prompt + Variables + AI assist -->
      <div class="field">
        <PromptField
          v-model="prompt"
          v-model:variables="variables"
          :rows="12"
          :variable-groups="agentVariableGroups"
          :agent-id="agentId"
          :agent-system-prompt-ids="selectedSysprompts"
          :required="true"
          hint="Ruta de archivo (./prompts/mi-prompt.md) o texto inline."
        />
      </div>

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



/* ── System Prompts chips ─────────────────────────────────────────── */
.sp-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.sp-chip {
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
.sp-chip:hover { border-color: #6366f1; color: #4f46e5; }
.sp-chip.active { border-color: #6366f1; background: #eef2ff; color: #4f46e5; font-weight: 500; }
.sp-check { width: 0.8rem; font-size: 0.72rem; color: #6366f1; }
.sp-chip-name { font-weight: 500; }
</style>
