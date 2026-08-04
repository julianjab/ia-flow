<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Provider, ProviderId, StepId } from '../stores/providers';

const STEP_INFO: Record<StepId, { label: string; description: string }> = {
  'refine-functional': {
    label: 'Refine Functional',
    description: 'Genera el PRD funcional: user stories, criterios de aceptación y repos impactados.',
  },
  'refine-technical': {
    label: 'Refine Technical',
    description: 'Descompone el PRD funcional en specs técnicas por repo: archivos, contratos de API y tests.',
  },
  implement: {
    label: 'Implement',
    description: 'Lanza Claude Code en cada repo afectado para ejecutar el spec técnico.',
  },
};

const props = defineProps<{
  open: boolean;
  step: StepId | null;
  currentProvider: ProviderId;
  providers: Provider[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', step: StepId, provider: ProviderId): void;
}>();

const selectedProvider = ref<ProviderId>('');

watch(
  () => props.open,
  (open) => {
    if (open) selectedProvider.value = props.currentProvider;
  },
);

function onSave() {
  if (!props.step) return;
  emit('save', props.step, selectedProvider.value);
}

function onBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open && step" class="modal-backdrop" @click="onBackdropClick">
      <div class="modal" role="dialog" aria-modal="true">
        <header class="modal-header">
          <div>
            <h2>{{ STEP_INFO[step].label }}</h2>
            <p class="modal-subtitle">{{ STEP_INFO[step].description }}</p>
          </div>
          <button class="close-btn" type="button" aria-label="Cerrar" @click="$emit('close')">✕</button>
        </header>

        <div class="modal-body">
          <div class="field">
            <label for="step-provider">Provider</label>
            <select id="step-provider" v-model="selectedProvider">
              <option v-for="p in providers" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
            <span class="field-hint">
              {{ providers.find((p) => p.id === selectedProvider)?.description ?? '' }}
            </span>
          </div>
        </div>

        <footer class="modal-footer">
          <button type="button" class="btn-secondary" @click="$emit('close')">Cancelar</button>
          <button type="button" class="btn-primary" @click="onSave">Guardar</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 100%;
  max-width: 420px;
  display: flex;
  flex-direction: column;
}
.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem 0.75rem;
  border-bottom: 1px solid #e5e7eb;
}
.modal-header h2 {
  margin: 0 0 0.2rem;
  font-size: 1.05rem;
}
.modal-subtitle {
  margin: 0;
  font-size: 0.8rem;
  color: #6b7280;
  line-height: 1.4;
}
.close-btn {
  flex-shrink: 0;
  background: none;
  border: none;
  font-size: 1rem;
  cursor: pointer;
  color: #6b7280;
  padding: 0.1rem;
  line-height: 1;
}
.close-btn:hover { color: #111; }
.modal-body {
  padding: 1.25rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.field label {
  font-size: 0.85rem;
  font-weight: 500;
  color: #374151;
}
.field select {
  padding: 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.875rem;
  background: #fff;
  cursor: pointer;
}
.field select:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}
.field-hint {
  font-size: 0.75rem;
  color: #9ca3af;
  min-height: 1rem;
}
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem 1rem;
  border-top: 1px solid #e5e7eb;
}
.btn-primary {
  padding: 0.45rem 1.1rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
}
.btn-primary:hover { background: #1d4ed8; }
.btn-secondary {
  padding: 0.45rem 1.1rem;
  background: #fff;
  color: #374151;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
}
.btn-secondary:hover { background: #f9fafb; }
</style>
