<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { AgentDefinition } from '@ia-flow/shared';
import PromptEditorWithChips from './PromptEditorWithChips.vue';

interface KV { key: string; value: string }

const props = defineProps<{
  open: boolean;
  agent: AgentDefinition | null;
  providers: { id: string; name: string }[];
}>();

const emit = defineEmits<{
  close: [];
  save: [agent: AgentDefinition];
}>();

// ─── Form state ───────────────────────────────────────────────────────────────

const agentId   = ref('');
const provider  = ref('anthropic-api');
const prompt    = ref('');
const variables = ref<KV[]>([]);

// ─── Hydrate when opening ─────────────────────────────────────────────────────

watch(() => props.open, (open) => {
  if (!open) return;
  const a = props.agent;
  if (a) {
    agentId.value   = a.id;
    provider.value  = a.provider;
    prompt.value    = a.prompt;
    variables.value = Object.entries(a.variables ?? {}).map(([key, value]) => ({ key, value }));
  } else {
    agentId.value   = '';
    provider.value  = props.providers[0]?.id ?? 'anthropic-api';
    prompt.value    = '';
    variables.value = [];
  }
});

// ─── Variable helpers ─────────────────────────────────────────────────────────

function addVariable() { variables.value.push({ key: '', value: '' }); }
function removeVariable(i: number) { variables.value.splice(i, 1); }
function kvToRecord(list: KV[]): Record<string, string> {
  return Object.fromEntries(list.filter(kv => kv.key).map(kv => [kv.key, kv.value]));
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
  return agent;
}

function onSave() {
  if (!validate()) return;
  emit('save', buildAgent());
}

const title = computed(() => props.agent ? `Editar agente — ${props.agent.id}` : 'Nuevo agente');
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>{{ title }}</h3>
        <button class="close-btn" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">

        <!-- ── Identity ──────────────────────────────────────────── -->
        <div class="field">
          <span class="label">ID <span class="req">*</span></span>
          <input v-model="agentId" class="input" placeholder="functional-refiner" :disabled="!!props.agent" />
          <span class="field-hint">Identificador único, sin espacios. Referenciado desde statuses.</span>
        </div>

        <!-- ── Provider ──────────────────────────────────────────── -->
        <div class="field" style="margin-top: 0.75rem;">
          <span class="label">Provider <span class="req">*</span></span>
          <select v-model="provider" class="input select">
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name ?? p.id }}</option>
          </select>
        </div>

        <!-- ── Prompt ────────────────────────────────────────────── -->
        <div class="field" style="margin-top: 0.75rem;">
          <span class="label">Prompt <span class="req">*</span></span>
          <span class="field-hint">
            Ruta de archivo (<code>./prompts/mi-prompt.md</code>) o texto inline.
          </span>
          <PromptEditorWithChips v-model="prompt" :rows="6" />
        </div>

        <!-- ── Variables ─────────────────────────────────────────── -->
        <div class="field" style="margin-top: 0.75rem;">
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

        <!-- ── Errors ────────────────────────────────────────────── -->
        <div v-if="errors.length" class="error-list" style="margin-top: 0.75rem;">
          <p v-for="e in errors" :key="e">{{ e }}</p>
        </div>

      </div>

      <div class="modal-foot">
        <button class="btn-cancel" @click="emit('close')">Cancelar</button>
        <button class="btn-save" @click="onSave">Guardar agente</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 1rem;
}
.modal {
  background: #fff;
  border-radius: 12px;
  width: min(720px, 100%);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.22);
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem 0.75rem;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.modal-head h3 { margin: 0; font-size: 1rem; }
.close-btn {
  background: none;
  border: none;
  font-size: 1rem;
  color: #6b7280;
  cursor: pointer;
  padding: 0.2rem 0.4rem;
  line-height: 1;
}
.close-btn:hover { color: #111; }
.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.25rem 1.25rem;
  display: flex;
  flex-direction: column;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem 1rem;
  border-top: 1px solid #f3f4f6;
  flex-shrink: 0;
}

.field { display: flex; flex-direction: column; gap: 0.25rem; }
.label { font-size: 0.8rem; font-weight: 500; color: #374151; }
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
.input:disabled { background: #f9fafb; color: #6b7280; cursor: not-allowed; }
.select { cursor: pointer; }

.kv-list { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.25rem; }
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
  line-height: 1;
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
  padding: 0.25rem 0.6rem;
  cursor: pointer;
}
.btn-add-kv:hover { border-color: #2563eb; color: #2563eb; }

.error-list {
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
.error-list p { margin: 0.15rem 0; font-size: 0.8rem; color: #dc2626; }

.btn-cancel {
  padding: 0.4rem 1rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 0.875rem;
  cursor: pointer;
  color: #374151;
}
.btn-cancel:hover { background: #f9fafb; }
.btn-save {
  padding: 0.4rem 1.2rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-save:hover { background: #1d4ed8; }
</style>
