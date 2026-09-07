<script setup lang="ts">
import FullScreen from '@/ui/FullScreen.vue';
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
  /** Hay algo que borrar: este proyecto ya configuró el status. El status en
   *  sí lo define la fuente y no es nuestro para borrar. */
  deletable?: boolean;
}>(), { statusOptions: () => [], nameLocked: false, deletable: false });

const emit = defineEmits<{
  close: [];
  save: [status: StatusConfig];
  delete: [statusName: string];
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
  <!-- Bajo --bp-shell es una pantalla con `←` (A3). `FullScreen` trae el
       backdrop, el Escape, el bloqueo de scroll y el pie fijo. -->
  <FullScreen :open="open" :title="title" @close="emit('close')">
    <label class="ff-row">
      <span class="uc-label">Nombre del status *</span>
      <select
        v-if="statusOptions.length"
        v-model="name"
        class="ff-field"
        :disabled="!!props.statusConfig"
      >
        <option value="" disabled>— Selecciona un status —</option>
        <option v-for="opt in statusOptions" :key="opt" :value="opt">{{ opt }}</option>
      </select>
      <input
        v-else
        v-model="name"
        class="ff-field"
        placeholder="queued"
        :disabled="!!props.statusConfig"
      />
      <span class="ff-hint">
        {{ statusOptions.length
          ? 'Opciones del campo Status del Project v2.'
          : 'Nombre del status que activa este nodo del flujo.' }}
      </span>
    </label>

    <p class="ff-hint agents-hint">
      Qué agente corre en este status, y si procesa tareas bloqueadas, se configura desde
      el editor de cada agente (campos Status y "Permitir procesar tareas bloqueadas" en
      Activación) — ver la lista de agentes debajo en esta misma sección.
    </p>

    <div v-if="errors.length" class="error-list">
      <p v-for="e in errors" :key="e" class="ff-error">{{ e }}</p>
    </div>

    <template #footer>
      <!-- Borrar vive acá y no en la tarjeta del listado: se hace una vez y
           desde acá se ve QUÉ configuración se está por borrar. Va último y
           separado, como pide el design system. -->
      <button class="btn" type="button" @click="emit('close')">Cancelar</button>
      <button class="btn btn--primary" type="button" @click="onSave">Guardar status</button>
      <button
        v-if="deletable"
        class="btn btn--danger"
        type="button"
        @click="emit('delete', name)"
      >Eliminar</button>
    </template>
  </FullScreen>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
/* La caja, el backdrop y el pie los pone `FullScreen`; los campos,
   `form-fields.css`. Lo que había acá era una copia de las dos. */
.agents-hint {
  padding: 0.5rem 0.6rem;
  border-left: 2px solid var(--border-hi);
  background: var(--panel-alt);
}
.error-list { display: flex; flex-direction: column; gap: 0.2rem; }
</style>
