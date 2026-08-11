<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { StatusConfig, StatusAgentEntry } from '@ia-flow/shared';
import AgentRunnerCard, {
  type AgentRunnerEntry,
  type ProjectField,
  emptyEntry,
  entryToWhen,
  whenToConditions,
  serializeAssignments,
  deserializeAssignments,
} from '@/features/agents/AgentRunnerCard.vue';

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

const emit = defineEmits<{
  close: [];
  save: [status: StatusConfig];
}>();

// ─── Form state ───────────────────────────────────────────────────────────────

const name            = ref('');
const agentEntries    = ref<AgentRunnerEntry[]>([]);

// ─── Hydrate ──────────────────────────────────────────────────────────────────

watch(() => props.open, (open) => {
  if (!open) return;
  const s = props.statusConfig;
  if (s) {
    name.value = s.name;
    agentEntries.value = (s.agents ?? []).map(e => ({
      agent: e.agent,
      conditions: whenToConditions(e.when),
      onProcess: deserializeAssignments(e.onProcess),
      onFinish:  deserializeAssignments(e.onFinish),
      onError:   deserializeAssignments(e.onError),
    }));
  } else {
    name.value = '';
    agentEntries.value = [emptyEntry(props.agentIds[0])];
  }
});

function addAgentEntry() {
  agentEntries.value.push(emptyEntry(props.agentIds[0]))
}

// ─── Validation ───────────────────────────────────────────────────────────────

const errors = ref<string[]>([]);

function validate(): boolean {
  errors.value = [];
  if (!name.value.trim()) errors.value.push('El nombre del status es requerido.');
  if (!agentEntries.value.length) errors.value.push('Se requiere al menos un agente.');
  for (const [i, e] of agentEntries.value.entries()) {
    if (!e.agent.trim()) errors.value.push(`Entrada ${i + 1}: se requiere un agente.`);
    if (e.conditions.some(c => !c.field.trim()))
      errors.value.push(`Entrada ${i + 1}: todas las condiciones deben tener campo.`);
    if (e.conditions.some(c => (c.op === '=' || c.op === '!=') && !c.value.trim()))
      errors.value.push(`Entrada ${i + 1}: condiciones con "= igual" o "!= distinto" requieren un valor.`);
  }
  return errors.value.length === 0;
}

// ─── Build & Save ─────────────────────────────────────────────────────────────

function buildStatus(): StatusConfig {
  const agents: StatusAgentEntry[] = agentEntries.value.map(e => {
    const entry: StatusAgentEntry = { agent: e.agent };
    const when = entryToWhen(e.conditions);
    if (when.length) entry.when = when;
    const onProcess = serializeAssignments(e.onProcess);
    const onFinish  = serializeAssignments(e.onFinish);
    const onError   = serializeAssignments(e.onError);
    if (onProcess) entry.onProcess = onProcess;
    if (onFinish)  entry.onFinish  = onFinish;
    if (onError)   entry.onError   = onError;
    return entry;
  });
  return { name: name.value.trim(), agents };
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

          <AgentRunnerCard
            v-for="(_, ei) in agentEntries"
            :key="ei"
            v-model="agentEntries[ei]"
            :agent-ids="agentIds"
            :project-fields="projectFields"
            :status-options="statusOptions"
            style="margin-bottom: 0.5rem;"
            @remove="agentEntries.splice(ei, 1)"
          />

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

.conditions-empty { font-size: 0.8rem; color: #9ca3af; font-style: italic; padding: 0.25rem 0; }

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
