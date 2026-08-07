<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import PromptField from '@/features/prompts/PromptField.vue';
import ModelSelect from '@/features/providers/ModelSelect.vue';
import type { VariableGroup, KV } from '@/features/prompts/PromptField.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProvidersStore } from '@/features/providers/store';
import type { AgentDefinition, SystemPromptDef, AgentProviderConfig } from '@ia-flow/shared';

type ProviderId = 'anthropic-api' | 'tmux-claude' | 'iterm-claude';
interface AnthropicApiPcState { model?: string; maxTokens?: number; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; taskBudgetTokens?: number; maxIters?: number }
interface TerminalPcState { model?: string; dangerouslySkipPermissions?: boolean }

function isTerminalProvider(p: string): p is 'tmux-claude' | 'iterm-claude' {
  return p === 'tmux-claude' || p === 'iterm-claude';
}
function isOpusModel(model: string | undefined): boolean {
  if (!model) return false;
  return /opus/i.test(model);
}

interface ToolDef { name: string; description: string }

const props = defineProps<{
  open: boolean;
  agent: AgentDefinition | null;  // null = new agent
}>();

const emit = defineEmits<{
  close: [];
  save: [agent: AgentDefinition];
}>();

const projectConfigStore = useProjectConfigStore();
const providersStore     = useProvidersStore();

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

// ─── Form state ───────────────────────────────────────────────────────────────

const agentId            = ref('');
const provider           = ref('anthropic-api');
const prompt             = ref('');
const variables          = ref<KV[]>([]);
const selectedTools      = ref<string[]>([]);
const selectedSysprompts = ref<string[]>([]);
const pcAnthropic        = ref<AnthropicApiPcState>({});
const pcTerminal         = ref<TerminalPcState>({});
const availableTools     = ref<ToolDef[]>([]);
const errors             = ref<string[]>([]);
const saving             = ref(false);

const isNew = computed(() => props.agent === null);
const title = computed(() => isNew.value ? 'Nuevo agente' : `Editar agente — ${props.agent?.id}`);

const providers           = computed(() => providersStore.providers);
const availableSysprompts = computed<SystemPromptDef[]>(() => projectConfigStore.config?.systemPrompts ?? []);

// ─── Hydrate on open ──────────────────────────────────────────────────────────

watch(() => props.open, async (open) => {
  if (!open) return;
  errors.value = [];
  const a = props.agent;
  if (a) {
    agentId.value            = a.id;
    provider.value           = a.provider;
    prompt.value             = a.prompt;
    variables.value          = Object.entries(a.variables ?? {}).map(([key, value]) => ({ key, value }));
    selectedTools.value      = a.tools ?? [];
    selectedSysprompts.value = a.systemPrompts ?? [];
    pcAnthropic.value = {};
    pcTerminal.value  = {};
    if (a.providerConfig?.provider === 'anthropic-api') {
      const { provider: _p, ...rest } = a.providerConfig;
      pcAnthropic.value = { ...rest };
    } else if (a.providerConfig && isTerminalProvider(a.providerConfig.provider)) {
      const { provider: _p, ...rest } = a.providerConfig;
      pcTerminal.value = { ...rest };
    }
  } else {
    agentId.value            = '';
    provider.value           = providers.value[0]?.id ?? 'anthropic-api';
    prompt.value             = '';
    variables.value          = [];
    selectedTools.value      = [];
    selectedSysprompts.value = [];
    pcAnthropic.value        = {};
    pcTerminal.value         = {};
  }

  if (!availableTools.value.length) {
    try {
      const res = await fetch(`${API_BASE}/api/tools`);
      if (res.ok) availableTools.value = await res.json();
    } catch { /* server may not be running */ }
  }
});

// Reset per-agent providerConfig state when the selected provider changes.
watch(provider, (next, prev) => {
  if (next === prev) return;
  pcAnthropic.value = {};
  pcTerminal.value  = {};
});

// ─── Provider-config helpers ─────────────────────────────────────────────────

const showAnthropicPc = computed(() => provider.value === 'anthropic-api');
const showTerminalPc  = computed(() => isTerminalProvider(provider.value));

const effortWarning = computed(() => {
  if (!showAnthropicPc.value) return '';
  const { effort, taskBudgetTokens, model } = pcAnthropic.value;
  const highEffort = effort === 'xhigh' || effort === 'max';
  if ((highEffort || taskBudgetTokens != null) && !isOpusModel(model)) {
    return 'Los valores de effort xhigh/max y task budget se aprovechan mejor con Opus 4.6/4.7.';
  }
  return '';
});

function numberInput(e: Event): number | undefined {
  const v = (e.target as HTMLInputElement).value;
  return v === '' ? undefined : Number(v);
}

// ─── Toggles ─────────────────────────────────────────────────────────────────

function toggleSysprompt(id: string) {
  const idx = selectedSysprompts.value.indexOf(id);
  if (idx === -1) selectedSysprompts.value.push(id);
  else selectedSysprompts.value.splice(idx, 1);
}

function toggleTool(name: string) {
  const idx = selectedTools.value.indexOf(name);
  if (idx === -1) selectedTools.value.push(name);
  else selectedTools.value.splice(idx, 1);
}

// ─── Validation & save ────────────────────────────────────────────────────────

function kvToRecord(list: KV[]): Record<string, string> {
  return Object.fromEntries(list.filter(kv => kv.key).map(kv => [kv.key, kv.value]));
}

function validate(): boolean {
  errors.value = [];
  if (!agentId.value.trim()) errors.value.push('El id es requerido.');
  if (/\s/.test(agentId.value)) errors.value.push('El id no puede tener espacios.');
  if (!provider.value.trim()) errors.value.push('El provider es requerido.');
  if (!prompt.value.trim()) errors.value.push('El prompt es requerido.');
  return errors.value.length === 0;
}

function onSave() {
  if (!validate()) return;
  const agent: AgentDefinition = {
    id: agentId.value.trim(),
    provider: provider.value,
    prompt: prompt.value,
  };
  if (selectedSysprompts.value.length) agent.systemPrompts = [...selectedSysprompts.value];
  const vars = kvToRecord(variables.value);
  if (Object.keys(vars).length) agent.variables = vars;
  if (selectedTools.value.length) agent.tools = [...selectedTools.value];
  const pc = buildProviderConfig();
  if (pc) agent.providerConfig = pc;
  emit('save', agent);
}

function buildProviderConfig(): AgentProviderConfig | undefined {
  if (showAnthropicPc.value) {
    const s = pcAnthropic.value;
    const hasAny = s.model || s.maxTokens != null || s.effort || s.taskBudgetTokens != null || s.maxIters != null;
    if (!hasAny) return undefined;
    return {
      provider: 'anthropic-api',
      ...(s.model            ? { model: s.model } : {}),
      ...(s.maxTokens != null        ? { maxTokens: s.maxTokens } : {}),
      ...(s.effort           ? { effort: s.effort } : {}),
      ...(s.taskBudgetTokens != null ? { taskBudgetTokens: s.taskBudgetTokens } : {}),
      ...(s.maxIters != null         ? { maxIters: s.maxIters } : {}),
    };
  }
  if (showTerminalPc.value) {
    const s = pcTerminal.value;
    const hasAny = s.model || s.dangerouslySkipPermissions === true;
    if (!hasAny) return undefined;
    return {
      provider: provider.value as 'tmux-claude' | 'iterm-claude',
      ...(s.model                      ? { model: s.model } : {}),
      ...(s.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
    };
  }
  return undefined;
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
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="modal">

      <div class="modal-head">
        <h3>{{ title }}</h3>
        <button class="close-btn" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">

        <!-- System Prompts -->
        <div v-if="availableSysprompts.length" class="field">
          <span class="label">System Prompts</span>
          <span class="field-hint">Sin selección = ninguno extra.</span>
          <div class="chip-grid">
            <label
              v-for="sp in availableSysprompts"
              :key="sp.id"
              class="chip"
              :class="{ active: selectedSysprompts.includes(sp.id) }"
              :title="sp.text"
              @click="toggleSysprompt(sp.id)"
            >
              <span class="chip-check">{{ selectedSysprompts.includes(sp.id) ? '✓' : '' }}</span>
              <span>{{ sp.name }}</span>
            </label>
          </div>
        </div>

        <!-- ID -->
        <div class="field">
          <span class="label">ID <span class="req">*</span></span>
          <span class="field-hint">Sin espacios. Referenciado desde statuses.</span>
          <input v-model="agentId" class="input" placeholder="functional-refiner" :disabled="!isNew" />
        </div>

        <!-- Provider -->
        <div class="field">
          <span class="label">Provider <span class="req">*</span></span>
          <select v-model="provider" class="input select">
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name ?? p.id }}</option>
          </select>
        </div>

        <!-- Per-agent provider config -->
        <div v-if="showAnthropicPc || showTerminalPc" class="field">
          <span class="label">Configuración del provider (por agente)</span>
          <span class="field-hint">Sobrescribe los defaults globales del provider. Vacío = usa el default global.</span>

          <div v-if="showAnthropicPc" class="pc-grid">
            <div class="pc-field">
              <label class="pc-label">Model</label>
              <ModelSelect
                :model-value="pcAnthropic.model"
                :allow-empty="true"
                empty-label="— usa el modelo global —"
                @update:model-value="pcAnthropic.model = $event"
              />
              <p class="field-hint">Opus, Sonnet, Haiku — sobrescribe el modelo global.</p>
            </div>
            <div class="pc-field">
              <label class="pc-label">Max tokens</label>
              <input type="number" min="1" class="input" placeholder="32000" :value="pcAnthropic.maxTokens ?? ''" @input="pcAnthropic.maxTokens = numberInput($event)" />
              <p class="field-hint">Máximo de tokens generados por respuesta. Default 32000.</p>
            </div>
            <div class="pc-field">
              <label class="pc-label">Effort</label>
              <select class="input select" :value="pcAnthropic.effort ?? ''" @change="pcAnthropic.effort = (($event.target as HTMLSelectElement).value || undefined) as any">
                <option value="">— default —</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
                <option value="max">max</option>
              </select>
              <p class="field-hint">Nivel de esfuerzo/razonamiento. xhigh/max requieren Opus 4.6/4.7.</p>
            </div>
            <div class="pc-field">
              <label class="pc-label">Task budget (tokens)</label>
              <input type="number" min="20000" class="input" placeholder="≥ 20000" :value="pcAnthropic.taskBudgetTokens ?? ''" @input="pcAnthropic.taskBudgetTokens = numberInput($event)" />
              <p class="field-hint">Presupuesto total de tokens por tarea (beta task-budgets). Mínimo 20000. Recomendado Opus 4.6/4.7.</p>
            </div>
            <div class="pc-field">
              <label class="pc-label">Max iteraciones</label>
              <input type="number" min="1" class="input" placeholder="15" :value="pcAnthropic.maxIters ?? ''" @input="pcAnthropic.maxIters = numberInput($event)" />
              <p class="field-hint">Iteraciones del tool loop. Precedencia: providerConfig &gt; maxIters (legacy) &gt; global.</p>
            </div>
            <p v-if="effortWarning" class="pc-warning">⚠ {{ effortWarning }}</p>
          </div>

          <div v-if="showTerminalPc" class="pc-grid">
            <div class="pc-field">
              <label class="pc-label">Model</label>
              <ModelSelect
                :model-value="pcTerminal.model"
                :allow-empty="true"
                empty-label="— default de Claude CLI —"
                @update:model-value="pcTerminal.model = $event"
              />
              <p class="field-hint">Se traduce a <code>--model &lt;value&gt;</code> en el CLI de Claude.</p>
            </div>
            <div class="pc-field">
              <label class="pc-label">
                <input type="checkbox" :checked="pcTerminal.dangerouslySkipPermissions === true" @change="pcTerminal.dangerouslySkipPermissions = ($event.target as HTMLInputElement).checked ? true : undefined" />
                Dangerously skip permissions
              </label>
              <p class="field-hint">Añade <code>--dangerously-skip-permissions</code>. Solo úsalo en entornos aislados.</p>
            </div>
          </div>
        </div>

        <!-- Prompt -->
        <div class="field">
          <PromptField
            v-model="prompt"
            v-model:variables="variables"
            :rows="10"
            :variable-groups="AGENT_VARIABLE_GROUPS"
            :agent-id="agentId"
            :required="true"
            hint="Ruta de archivo (./prompts/mi-prompt.md) o texto inline."
          />
        </div>

        <!-- Tools -->
        <div class="field">
          <span class="label">Tools</span>
          <span class="field-hint">Sin selección = todas.</span>
          <div v-if="availableTools.length" class="chip-grid">
            <label
              v-for="tool in availableTools"
              :key="tool.name"
              class="chip"
              :class="{ active: selectedTools.includes(tool.name) }"
              :title="tool.description"
              @click="toggleTool(tool.name)"
            >
              <span class="chip-check">{{ selectedTools.includes(tool.name) ? '✓' : '' }}</span>
              <span class="chip-mono">{{ tool.name }}</span>
            </label>
          </div>
          <p v-else class="field-hint" style="font-style:italic">Servidor no disponible — inicia el servidor para ver tools.</p>
        </div>

        <!-- Errors -->
        <div v-if="errors.length" class="error-list">
          <p v-for="e in errors" :key="e">{{ e }}</p>
        </div>

      </div>

      <div class="modal-foot">
        <button class="btn-cancel" @click="emit('close')">Cancelar</button>
        <button class="btn-save" :disabled="saving" @click="onSave">Guardar agente</button>
      </div>

    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 1rem;
}

.modal {
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 100%;
  max-width: 720px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.modal-head h3 { margin: 0; font-size: 1rem; font-weight: 600; color: #111827; }

.close-btn {
  background: none;
  border: none;
  font-size: 1rem;
  color: #9ca3af;
  cursor: pointer;
  padding: 0.25rem;
  line-height: 1;
}
.close-btn:hover { color: #374151; }

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.85rem 1.25rem;
  border-top: 1px solid #e5e7eb;
  flex-shrink: 0;
}

/* ── Fields ─────────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.label { font-size: 0.82rem; font-weight: 600; color: #374151; }
.req { color: #ef4444; }
.field-hint { font-size: 0.73rem; color: #9ca3af; line-height: 1.4; }

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

/* ── Chips ──────────────────────────────────────────────────────────── */
.chip-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.chip {
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
.chip:hover { border-color: #6366f1; color: #4f46e5; }
.chip.active { border-color: #6366f1; background: #eef2ff; color: #4f46e5; font-weight: 500; }
.chip-check { width: 0.8rem; font-size: 0.72rem; color: #6366f1; }
.chip-mono { font-family: 'SF Mono', 'Fira Code', monospace; }

/* ── Buttons ────────────────────────────────────────────────────────── */
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

/* ── Provider config (per-agent) ────────────────────────────────────── */
.pc-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem 1rem;
  padding: 0.75rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
}
.pc-field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.pc-label { font-size: 0.78rem; font-weight: 500; color: #374151; }
.pc-field :deep(.model-select) {
  padding: 0.45rem 0.65rem;
  font-size: 0.875rem;
  width: 100%;
  flex: none;
}
.pc-warning {
  grid-column: 1 / -1;
  margin: 0;
  padding: 0.4rem 0.6rem;
  font-size: 0.75rem;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fcd34d;
  border-radius: 4px;
}

/* ── Errors ─────────────────────────────────────────────────────────── */
.error-list {
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
.error-list p { margin: 0.15rem 0; font-size: 0.8rem; color: #dc2626; }
</style>
