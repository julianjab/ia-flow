<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { StatusConfig, StatusAgentEntry } from '@ia-flow/shared';

interface KV { field: string; value: string }
interface AgentEntry { agent: string; conditions: KV[]; onProcess: string; onFinish: string; onError: string }
interface ProjectField { name: string; dataType: string; options: string[] }

const props = withDefaults(defineProps<{
  open: boolean;
  statusConfig: StatusConfig | null;
  agentIds: string[];
  projectFields?: ProjectField[];
  nameLocked?: boolean;
}>(), { projectFields: () => [], nameLocked: false });

const statusOptions = computed(() => {
  const f = props.projectFields.find(pf => pf.name.toLowerCase() === 'status');
  return f?.options ?? [];
});
const fieldNames = computed(() => props.projectFields.map(f => f.name));
function optionsFor(fieldName: string): string[] {
  const f = props.projectFields.find(pf => pf.name.toLowerCase() === fieldName.toLowerCase());
  return f?.options ?? [];
}

const emit = defineEmits<{
  close: [];
  save: [status: StatusConfig];
}>();

// ─── Form state ───────────────────────────────────────────────────────────────

const name         = ref('');
const contextRepos = ref<'task' | 'all' | 'custom'>('task');
const contextRepoList = ref('');
const agentEntries = ref<AgentEntry[]>([]);

// ─── Hydrate ──────────────────────────────────────────────────────────────────

watch(() => props.open, (open) => {
  if (!open) return;
  const s = props.statusConfig;
  if (s) {
    name.value = s.name;
    const repos = s.context?.repos;
    if (!repos || repos === 'task') {
      contextRepos.value = 'task';
      contextRepoList.value = '';
    } else if (repos === 'all') {
      contextRepos.value = 'all';
      contextRepoList.value = '';
    } else {
      contextRepos.value = 'custom';
      contextRepoList.value = (repos as string[]).join(', ');
    }
    agentEntries.value = (s.agents ?? []).map(e => ({
      agent: e.agent,
      conditions: Object.entries(e.when ?? {}).map(([field, value]) => ({ field, value })),
      onProcess: e.onProcess ?? '',
      onFinish: e.onFinish ?? '',
      onError: e.onError ?? '',
    }));
  } else {
    name.value = '';
    contextRepos.value = 'task';
    contextRepoList.value = '';
    agentEntries.value = [{ agent: props.agentIds[0] ?? '', conditions: [], onProcess: '', onFinish: '', onError: '' }];
  }
});

// ─── Agent entry helpers ──────────────────────────────────────────────────────

function addAgentEntry() {
  agentEntries.value.push({ agent: props.agentIds[0] ?? '', conditions: [], onProcess: '', onFinish: '', onError: '' });
}
function removeAgentEntry(i: number) { agentEntries.value.splice(i, 1); }
function addConditionRow(entry: AgentEntry) { entry.conditions.push({ field: '', value: '' }); }
function removeConditionRow(entry: AgentEntry, i: number) { entry.conditions.splice(i, 1); }

// ─── Validation ───────────────────────────────────────────────────────────────

const errors = ref<string[]>([]);

function validate(): boolean {
  errors.value = [];
  if (!name.value.trim()) errors.value.push('El nombre del status es requerido.');
  if (!agentEntries.value.length) errors.value.push('Se requiere al menos un agente.');
  for (const [i, e] of agentEntries.value.entries()) {
    if (!e.agent.trim()) errors.value.push(`Entrada ${i + 1}: se requiere un agente.`);
    if (e.conditions.some(c => !c.field.trim())) {
      errors.value.push(`Entrada ${i + 1}: todas las condiciones deben tener campo.`);
    }
  }
  return errors.value.length === 0;
}

// ─── Build & Save ─────────────────────────────────────────────────────────────

function buildStatus(): StatusConfig {
  const agents: StatusAgentEntry[] = agentEntries.value.map(e => {
    const entry: StatusAgentEntry = { agent: e.agent };
    if (e.conditions.length) {
      entry.when = Object.fromEntries(e.conditions.filter(c => c.field.trim()).map(c => [c.field.trim(), c.value.trim()]));
    }
    if (e.onProcess.trim()) entry.onProcess = e.onProcess.trim();
    if (e.onFinish.trim())  entry.onFinish  = e.onFinish.trim();
    if (e.onError.trim())   entry.onError   = e.onError.trim();
    return entry;
  });

  const repos = contextRepos.value === 'task'
    ? 'task' as const
    : contextRepos.value === 'all'
      ? 'all' as const
      : contextRepoList.value.split(',').map(s => s.trim()).filter(Boolean);

  return { name: name.value.trim(), agents, context: { repos } };
}

function onSave() {
  if (!validate()) return;
  emit('save', buildStatus());
}

const title = computed(() => props.statusConfig ? `Editar status — ${props.statusConfig.name}` : 'Nuevo status');
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>{{ title }}</h3>
        <button class="close-btn" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">

        <!-- ── Name ─────────────────────────────────────────────── -->
        <div class="field">
          <span class="label">Nombre del status <span class="req">*</span></span>
          <select
            v-if="statusOptions.length"
            v-model="name"
            class="input select"
            :disabled="!!props.statusConfig"
          >
            <option value="" disabled>— Selecciona un status —</option>
            <option v-for="opt in statusOptions" :key="opt" :value="opt">{{ opt }}</option>
          </select>
          <input
            v-else
            v-model="name"
            class="input"
            placeholder="queued"
            :disabled="!!props.statusConfig"
          />
          <span class="field-hint">
            {{ statusOptions.length
              ? 'Opciones del campo Status del Project v2.'
              : 'Nombre del status que activa este nodo del flujo.' }}
          </span>
        </div>

        <!-- ── Context repos ────────────────────────────────────── -->
        <div class="field" style="margin-top: 0.75rem;">
          <span class="label">Contexto de repos</span>
          <div class="radio-row">
            <label class="radio-label">
              <input v-model="contextRepos" type="radio" value="task" />
              <span>task — todos los repos de la tarea</span>
            </label>
            <label class="radio-label">
              <input v-model="contextRepos" type="radio" value="all" />
              <span>all — todos los repos conocidos</span>
            </label>
            <label class="radio-label">
              <input v-model="contextRepos" type="radio" value="custom" />
              <span>Lista específica</span>
            </label>
          </div>
          <input
            v-if="contextRepos === 'custom'"
            v-model="contextRepoList"
            class="input"
            placeholder="backend, frontend, mobile  (separados por coma)"
            style="margin-top: 0.4rem;"
          />
        </div>

        <!-- ── Agents ────────────────────────────────────────────── -->
        <div class="field" style="margin-top: 0.75rem;">
          <div class="section-head">
            <div>
              <span class="label">Agentes <span class="req">*</span></span>
              <p class="field-hint" style="margin: 0.1rem 0 0;">
                Todos los agentes cuyas condiciones hagan match corren en secuencia.
                Sin condiciones = siempre corre (default).
              </p>
            </div>
            <button class="btn-add-cond" @click="addAgentEntry">+ Agente</button>
          </div>

          <div v-for="(entry, ei) in agentEntries" :key="ei" class="condition-card">
            <div class="condition-head">
              <div class="entry-agent-row">
                <select v-model="entry.agent" class="input select entry-agent-select">
                  <option v-for="id in agentIds" :key="id" :value="id">{{ id }}</option>
                </select>
                <span v-if="!entry.conditions.length" class="default-badge">default</span>
              </div>
              <button class="kv-remove" @click="removeAgentEntry(ei)">✕</button>
            </div>

            <div class="field" style="margin-top: 0.3rem;">
              <div class="kv-list">
                <div v-for="(c, ci) in entry.conditions" :key="ci" class="kv-row">
                  <select
                    v-if="fieldNames.length"
                    v-model="c.field"
                    class="input select kv-key"
                  >
                    <option value="" disabled>— Campo —</option>
                    <option v-for="fn in fieldNames" :key="fn" :value="fn">{{ fn }}</option>
                  </select>
                  <input
                    v-else
                    v-model="c.field"
                    class="input kv-key"
                    placeholder="type"
                  />
                  <span class="kv-eq">=</span>
                  <select
                    v-if="optionsFor(c.field).length"
                    v-model="c.value"
                    class="input select kv-value"
                  >
                    <option value="" disabled>— Valor —</option>
                    <option v-for="opt in optionsFor(c.field)" :key="opt" :value="opt">{{ opt }}</option>
                  </select>
                  <input
                    v-else
                    v-model="c.value"
                    class="input kv-value"
                    placeholder="technical"
                  />
                  <button class="kv-remove" @click="removeConditionRow(entry, ci)">✕</button>
                </div>
                <button class="btn-add-kv" @click="addConditionRow(entry)">+ Condición</button>
              </div>
            </div>

            <!-- Per-agent transitions -->
            <div class="entry-transitions">
              <div class="field entry-trans-field">
                <span class="label entry-trans-label">En proceso</span>
                <select v-if="statusOptions.length" v-model="entry.onProcess" class="input select input-sm">
                  <option value="">— —</option>
                  <option v-for="opt in statusOptions" :key="opt" :value="opt">{{ opt }}</option>
                </select>
                <input v-else v-model="entry.onProcess" class="input input-sm" placeholder="refining" />
              </div>
              <div class="field entry-trans-field">
                <span class="label entry-trans-label">Al terminar</span>
                <select v-if="statusOptions.length" v-model="entry.onFinish" class="input select input-sm">
                  <option value="">— —</option>
                  <option v-for="opt in statusOptions" :key="opt" :value="opt">{{ opt }}</option>
                </select>
                <input v-else v-model="entry.onFinish" class="input input-sm" placeholder="refined" />
              </div>
              <div class="field entry-trans-field">
                <span class="label entry-trans-label">Al fallar</span>
                <select v-if="statusOptions.length" v-model="entry.onError" class="input select input-sm">
                  <option value="">— —</option>
                  <option v-for="opt in statusOptions" :key="opt" :value="opt">{{ opt }}</option>
                </select>
                <input v-else v-model="entry.onError" class="input input-sm" placeholder="queued" />
              </div>
            </div>
          </div>

          <div v-if="!agentEntries.length" class="conditions-empty">
            Sin agentes — agrega al menos uno.
          </div>
        </div>

        <!-- ── Errors ────────────────────────────────────────────── -->
        <div v-if="errors.length" class="error-list" style="margin-top: 0.75rem;">
          <p v-for="e in errors" :key="e">{{ e }}</p>
        </div>

      </div>

      <div class="modal-foot">
        <button class="btn-cancel" @click="emit('close')">Cancelar</button>
        <button class="btn-save" @click="onSave">Guardar status</button>
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
  width: min(620px, 100%);
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

.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.65rem 1rem; }
.field { display: flex; flex-direction: column; gap: 0.25rem; }
.label { font-size: 0.8rem; font-weight: 500; color: #374151; }
.req { color: #ef4444; }
.field-hint { font-size: 0.73rem; color: #9ca3af; line-height: 1.4; }

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

.radio-row { display: flex; gap: 1.5rem; }
.radio-label { display: flex; align-items: center; gap: 0.4rem; font-size: 0.83rem; cursor: pointer; color: #374151; }

.section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.5rem; }
.btn-add-cond {
  flex-shrink: 0;
  padding: 0.3rem 0.75rem;
  background: #ede9fe;
  color: #5b21b6;
  border: none;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-add-cond:hover { background: #ddd6fe; }

.condition-card {
  border: 1px solid #e9d5ff;
  border-radius: 8px;
  padding: 0.65rem 0.8rem;
  background: #faf5ff;
  margin-bottom: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.condition-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.entry-agent-row { display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0; }
.entry-agent-select { flex: 1; min-width: 0; }

.default-badge {
  flex-shrink: 0;
  font-size: 0.65rem;
  font-weight: 600;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  background: #d1fae5;
  color: #065f46;
}

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

.conditions-empty { font-size: 0.8rem; color: #9ca3af; font-style: italic; padding: 0.25rem 0; }

.entry-transitions {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 0.4rem 0.6rem;
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid #e9d5ff;
}
.entry-trans-field { gap: 0.15rem; }
.entry-trans-label { font-size: 0.7rem; color: #6b7280; font-weight: 500; }
.input-sm { font-size: 0.78rem; padding: 0.3rem 0.5rem; }

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
