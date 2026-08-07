<script setup lang="ts">
import { computed } from 'vue';
import type { StepType } from '@ia-flow/shared';
import type { PhaseVariable } from '@/features/prompts/api';
import PromptField from './PromptField.vue';
import type { VariableGroup } from './PromptField.vue';

const props = defineProps<{
  step: StepType;
  prompt: string;
  defaultPrompt: string;
  isCustomized: boolean;
  variables: PhaseVariable[];
  label?: string;
}>();

const emit = defineEmits<{
  (e: 'update:prompt', value: string): void;
  (e: 'reset'): void;
}>();

const phaseVariableGroups = computed<VariableGroup[]>(() => [
  {
    label: 'variables',
    items: props.variables.map(v => ({
      label: `{${v.key}}`,
      value: `{${v.key}}`,
      hint: v.description,
    })),
  },
]);
</script>

<template>
  <div
    class="phase-prompt-editor"
    :data-testid="`phase-prompt-editor-${step}`"
    :data-step="step"
  >
    <div class="header">
      <label :for="`phase-prompt-${step}`" class="phase-label">
        {{ label ?? step }}
      </label>
      <button
        v-if="isCustomized"
        type="button"
        class="btn-reset"
        :data-testid="`phase-prompt-reset-${step}`"
        @click="emit('reset')"
      >
        Restaurar por defecto
      </button>
    </div>

    <PromptField
      :model-value="prompt"
      :rows="10"
      :variable-groups="phaseVariableGroups"
      @update:model-value="emit('update:prompt', $event)"
    />
  </div>
</template>

<style scoped>
.phase-prompt-editor {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}

.phase-label {
  font-size: 0.875rem;
  font-weight: 600;
  color: #1e293b;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.btn-reset {
  padding: 0.25rem 0.65rem;
  font-size: 0.75rem;
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fcd34d;
  border-radius: 5px;
  cursor: pointer;
}
.btn-reset:hover { background: #fef3c7; }
</style>
