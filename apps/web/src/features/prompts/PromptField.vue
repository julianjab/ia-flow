<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { diffLines } from 'diff';
import PromptEditor from './PromptEditor.vue';
import AiAssistPanel from '@/features/agents/AiAssistPanel.vue';
import type { VariableGroup } from '@/features/prompts/PromptEditor.vue';
import { useToastStore } from '@/stores/toast';

export interface KV { key: string; value: string }

export type { VariableGroup };

const props = defineProps<{
  modelValue: string;
  variableGroups?: VariableGroup[];
  variables?: KV[];          // if provided, renders the editable KV section
  agentId?: string;
  agentSystemPromptIds?: string[];  // system prompts wired to this agent (context for AI assist)
  templateContext?: 'system-prompt' | 'agent-prompt' | 'phase-prompt';
  rows?: number;
  diffOnApply?: boolean;     // default true; false = apply AI result directly
  label?: string;
  required?: boolean;
  hint?: string;
  // Forwarded to AiAssistPanel so its sysprompt picker respects the caller's
  // scope (globals only in General, overlay in a project view).
  availableSystemPrompts?: import('@ia-flow/shared').SystemPromptDef[];
  // Externally-provided proposal (e.g. a form-level AI fill_form that
  // returned this field). When set, we open the diff view with it as the
  // proposal so the user can apply/discard through the same UI as refine.
  pendingProposal?: string | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'update:variables': [variables: KV[]];
  'clear-pending-proposal': [];
}>();

const toastStore = useToastStore();

// ─── AI assist ────────────────────────────────────────────────────────────────

const aiPanelOpen   = ref(false);
const aiProposed    = ref<string | null>(null);
const aiPendingMode = ref<'generate' | 'refine'>('generate');
const aiEditing     = ref(false);

interface DiffLine { text: string; added: boolean; removed: boolean }

const aiDiffLines = computed<DiffLine[]>(() => {
  if (aiProposed.value === null) return [];
  return diffLines(props.modelValue, aiProposed.value).flatMap(change =>
    change.value
      .split('\n')
      .filter((line, i, arr) => !(i === arr.length - 1 && line === ''))
      .map(text => ({ text, added: !!change.added, removed: !!change.removed })),
  );
});

// While there's an active proposal, iterate on it: the assistant treats
// the proposed prompt as the "current" one so refinements chain.
const assistBaselinePrompt = computed(() => aiProposed.value ?? props.modelValue);

function onAiResult(newPrompt: string, mode: 'generate' | 'refine') {
  aiPendingMode.value = mode;
  aiProposed.value = newPrompt;
  aiEditing.value = false;
  // Keep the panel open so the user can iterate on the proposal.
  aiPanelOpen.value = true;
}

function applyProposal() {
  if (aiProposed.value === null) return;
  emit('update:modelValue', aiProposed.value);
  aiProposed.value = null;
  aiEditing.value = false;
  aiPanelOpen.value = false;
  emit('clear-pending-proposal');
  toastStore.success(aiPendingMode.value === 'generate' ? 'Prompt generado ✨' : 'Prompt mejorado ✨');
}

function discardProposal() {
  aiProposed.value = null;
  aiEditing.value = false;
  emit('clear-pending-proposal');
}

// Ingest externally-provided proposals (e.g. form-level fill_form). Treated
// as a "refine" so the diff header reads "Cambios propuestos".
watch(
  () => props.pendingProposal,
  (val) => {
    if (val == null) return;
    if (val === props.modelValue) return;
    aiPendingMode.value = props.modelValue.trim() ? 'refine' : 'generate';
    aiProposed.value = val;
    aiEditing.value = false;
  },
  { immediate: true },
);

function toggleEdit() {
  aiEditing.value = !aiEditing.value;
}

function updateProposed(val: string) {
  aiProposed.value = val;
}

// ─── Variables KV list ────────────────────────────────────────────────────────

function updateVar(i: number, field: 'key' | 'value', val: string) {
  const next = (props.variables ?? []).map((kv, j) => j === i ? { ...kv, [field]: val } : kv);
  emit('update:variables', next);
}

function addVariable() {
  emit('update:variables', [...(props.variables ?? []), { key: '', value: '' }]);
}

function removeVariable(i: number) {
  const next = (props.variables ?? []).filter((_, j) => j !== i);
  emit('update:variables', next);
}
</script>

<template>
  <div class="prompt-field">
    <!-- Label row -->
    <div class="label-row">
      <span class="label">
        {{ label ?? 'Prompt' }}
        <span v-if="required" class="req">*</span>
      </span>
      <button class="btn-ai" :class="{ active: aiPanelOpen }" @click="aiPanelOpen = !aiPanelOpen">
        ✨ IA
      </button>
    </div>

    <p v-if="hint" class="hint">{{ hint }}</p>

    <!-- AI assist panel: stays open while a proposal is active so you can iterate -->
    <AiAssistPanel
      v-if="aiPanelOpen"
      :current-prompt="assistBaselinePrompt"
      :has-proposal="aiProposed !== null"
      :agent-id="agentId"
      :agent-variables="variables"
      :agent-system-prompt-ids="agentSystemPromptIds"
      :template-context="templateContext"
      :available-system-prompts="availableSystemPrompts"
      @result="onAiResult"
    />

    <!-- Diff / edit view -->
    <div v-if="aiProposed !== null" class="diff-panel">
      <div class="diff-header">
        <span class="diff-title">{{ aiPendingMode === 'generate' ? 'Prompt generado' : 'Cambios propuestos' }}</span>
        <div class="diff-actions">
          <button class="btn-edit" :class="{ active: aiEditing }" @click="toggleEdit">
            {{ aiEditing ? '👁 Ver diff' : '✏️ Editar' }}
          </button>
          <button class="btn-discard" @click="discardProposal">Descartar</button>
          <button class="btn-apply" @click="applyProposal">Aplicar cambios</button>
        </div>
      </div>
      <div v-if="!aiEditing" class="diff-view">
        <div
          v-for="(line, i) in aiDiffLines"
          :key="i"
          class="diff-line"
          :class="{ 'diff-added': line.added, 'diff-removed': line.removed }"
        >
          <span class="diff-marker">{{ line.added ? '+' : line.removed ? '−' : ' ' }}</span>
          <span class="diff-text">{{ line.text || ' ' }}</span>
        </div>
      </div>
      <textarea
        v-else
        class="proposal-editor"
        :value="aiProposed"
        rows="12"
        @input="updateProposed(($event.target as HTMLTextAreaElement).value)"
      />
    </div>

    <!-- Prompt textarea + variable chips -->
    <PromptEditor
      :model-value="modelValue"
      :rows="rows ?? 8"
      :variable-groups="variableGroups ?? []"
      @update:model-value="emit('update:modelValue', $event)"
    />

    <!-- Editable KV variables section (optional) -->
    <template v-if="variables !== undefined">
      <div class="vars-header">
        <span class="vars-label">Variables</span>
        <span class="vars-hint">Disponibles en el prompt como <code v-pre>{{variables.key}}</code></span>
      </div>
      <div class="kv-list">
        <div v-for="(kv, i) in variables" :key="i" class="kv-row">
          <input
            class="kv-input kv-key"
            placeholder="key"
            :value="kv.key"
            @input="updateVar(i, 'key', ($event.target as HTMLInputElement).value)"
          />
          <span class="kv-eq">=</span>
          <input
            class="kv-input kv-value"
            placeholder="value"
            :value="kv.value"
            @input="updateVar(i, 'value', ($event.target as HTMLInputElement).value)"
          />
          <button class="kv-remove" @click="removeVariable(i)">✕</button>
        </div>
        <button class="btn-add-kv" @click="addVariable">+ Variable</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.prompt-field {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--fg-mute);
}
.req { color: var(--danger); }

.hint {
  margin: 0;
  font-size: 0.73rem;
  color: var(--fg-dim);
  line-height: 1.4;
}
.hint code {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  background: var(--panel-hi);
  padding: 0.05rem 0.25rem;
  border-radius: 3px;
}

/* ── AI toggle button ──────────────────────────────────────────────── */
.btn-ai {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  background: var(--panel);
  font-size: 0.78rem;
  color: var(--fg-dim);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.btn-ai:hover { border-color: var(--magenta); color: var(--magenta); }
.btn-ai.active { border-color: var(--magenta); background: var(--panel-hi); color: var(--magenta); }

/* ── Diff view ─────────────────────────────────────────────────────── */
.diff-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.78rem;
}
.diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.55rem 0.85rem;
  background: var(--panel-alt);
  border-bottom: 1px solid var(--border);
}
.diff-title { font-size: 0.78rem; font-weight: 600; color: var(--fg-mute); }
.diff-actions { display: flex; gap: 0.4rem; }

.btn-discard {
  padding: 0.25rem 0.75rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  background: var(--panel);
  font-size: 0.75rem;
  color: var(--fg-dim);
  cursor: pointer;
}
.btn-discard:hover { background: var(--panel-hi); }

.btn-edit {
  padding: 0.25rem 0.75rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  background: var(--panel);
  font-size: 0.75rem;
  color: var(--fg-dim);
  cursor: pointer;
}
.btn-edit:hover { border-color: var(--magenta); color: var(--magenta); }
.btn-edit.active { border-color: var(--magenta); background: var(--panel-hi); color: var(--magenta); }

.proposal-editor {
  width: 100%;
  box-sizing: border-box;
  padding: 0.65rem 0.85rem;
  border: none;
  border-radius: 0;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.78rem;
  color: var(--fg);
  background: var(--panel);
  outline: none;
  resize: vertical;
  line-height: 1.55;
  min-height: 200px;
}
.proposal-editor:focus { background: #fefce8; }

.btn-apply {
  padding: 0.25rem 0.75rem;
  border: none;
  border-radius: 5px;
  background: var(--accent);
  color: var(--panel);
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-apply:hover { background: #15803d; }

.diff-view { max-height: 360px; overflow-y: auto; background: var(--panel); }
.diff-line {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.05rem 0.75rem;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.55;
}
.diff-added   { background: var(--green-bg); color: var(--accent); }
.diff-removed { background: var(--red-bg); color: var(--danger); text-decoration: line-through; }
.diff-marker  { flex-shrink: 0; width: 0.8rem; text-align: center; font-weight: 700; opacity: 0.7; }
.diff-text    { flex: 1; }

/* ── Variables section ─────────────────────────────────────────────── */
.vars-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.vars-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--fg-mute);
  flex-shrink: 0;
}
.vars-hint {
  font-size: 0.73rem;
  color: var(--fg-dim);
}
.vars-hint code {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  background: var(--panel-hi);
  padding: 0.05rem 0.25rem;
  border-radius: 3px;
}

.kv-list { display: flex; flex-direction: column; gap: 0.35rem; }
.kv-row  { display: flex; align-items: center; gap: 0.35rem; }

.kv-input {
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.875rem;
  color: var(--fg);
  background: var(--panel);
  box-sizing: border-box;
  outline: none;
  min-width: 0;
}
.kv-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
.kv-key   { flex: 1 1 6rem; }
.kv-value { flex: 2 1 10rem; }
.kv-eq { color: var(--fg-dim); font-size: 0.85rem; flex-shrink: 0; }
.kv-remove {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--danger);
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0.1rem 0.3rem;
  opacity: 0.7;
}
.kv-remove:hover { opacity: 1; }

.btn-add-kv {
  align-self: flex-start;
  background: none;
  border: 1px dashed var(--border-hi);
  border-radius: 5px;
  color: var(--fg-dim);
  font-size: 0.78rem;
  padding: 0.25rem 0.65rem;
  cursor: pointer;
}
.btn-add-kv:hover { border-color: var(--accent); color: var(--accent); }
</style>
