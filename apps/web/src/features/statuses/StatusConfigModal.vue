<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { StatusConfig } from '@ia-flow/shared';

// Un status ya no cablea agentes (ver AgentActivationSchema.statusName en
// packages/shared/src/schemas.ts) — este modal sólo administra el nombre
// del status. `allowBlocked` tampoco vive más acá: se movió a
// AgentActivationSchema.allowBlocked (el gate corre contra el agente que
// selectAgent va a ejecutar, no contra este status en abstracto) — se
// edita desde el editor del agente (AgentActivationSection).

const props = withDefaults(defineProps<{
  open: boolean;
  statusConfig: StatusConfig | null;
  statusOptions?: string[];
  nameLocked?: boolean;
}>(), { statusOptions: () => [], nameLocked: false });

const emit = defineEmits<{
  close: [];
  save: [status: StatusConfig];
}>();

// ─── Form state ───────────────────────────────────────────────────────────────

const name = ref('');

// ─── Hydrate ──────────────────────────────────────────────────────────────────

watch(() => props.open, (open) => {
  if (!open) return;
  const s = props.statusConfig;
  if (s) {
    name.value = s.name;
  } else {
    name.value = '';
  }
});

// ─── Validation ───────────────────────────────────────────────────────────────

const errors = ref<string[]>([]);

function validate(): boolean {
  errors.value = [];
  if (!name.value.trim()) errors.value.push('El nombre del status es requerido.');
  return errors.value.length === 0;
}

// ─── Build & Save ─────────────────────────────────────────────────────────────

function buildStatus(): StatusConfig {
  return { name: name.value.trim() };
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

        <!-- ── Hint: qué agentes corren acá ────────────────────── -->
        <p class="agents-hint">
          Qué agente corre en este status, y si procesa tareas bloqueadas, se configura desde
          el editor de cada agente (campos Status y "Permitir procesar tareas bloqueadas" en
          Activación) — ver la lista de agentes debajo en esta misma sección.
        </p>

        <!-- ── Errors ────────────────────────────────────────────── -->
        <div v-if="errors.length" class="error-list">
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
  background: var(--panel);
  border: 1px solid var(--border);
  width: min(560px, 100%);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem 0.75rem;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.modal-head h3 { margin: 0; font-size: 1rem; }
.close-btn {
  background: none;
  border: none;
  font-size: 1rem;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0.2rem 0.4rem;
  line-height: 1;
}
.close-btn:hover { color: var(--fg); }
.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.25rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem 1rem;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.field { display: flex; flex-direction: column; gap: 0.25rem; }
.label { font-size: 0.8rem; font-weight: 500; color: var(--fg-mute); }
.req { color: var(--danger); }
.field-hint { font-size: 0.73rem; color: var(--fg-dim); line-height: 1.4; }

.input {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border-hi);
  font-size: 0.84rem;
  color: var(--fg);
  background: var(--panel);
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: var(--accent); }
.input:disabled { background: var(--panel-alt); color: var(--fg-dim); cursor: not-allowed; }
.select { cursor: pointer; }

.agents-hint {
  margin: 0;
  font-size: var(--fs-body-sm);
  color: var(--fg-dim);
  line-height: 1.4;
  padding: 0.5rem 0.6rem;
  background: var(--panel-alt);
  border: 1px solid var(--border-mute);
}

.error-list {
  background: var(--red-bg);
  border: 1px solid var(--danger);
  padding: 0.5rem 0.75rem;
}
.error-list p { margin: 0.15rem 0; font-size: 0.8rem; color: var(--danger); }

.btn-cancel {
  padding: 0.4rem 1rem;
  border: 1px solid var(--border-hi);
  background: var(--panel);
  font-size: 0.875rem;
  cursor: pointer;
  color: var(--fg-mute);
}
.btn-cancel:hover { background: var(--panel-alt); }
.btn-save {
  padding: 0.4rem 1.2rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-save:hover { background: var(--accent); }
</style>
