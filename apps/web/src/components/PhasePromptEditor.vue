<script setup lang="ts">
import { ref } from 'vue';
import type { StepType } from '@ia-flow/shared';
import type { PhaseVariable } from '@/api/prompts';

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

const textareaRef = ref<HTMLTextAreaElement | null>(null);

function onInput(event: Event): void {
  const target = event.target as HTMLTextAreaElement;
  emit('update:prompt', target.value);
}

function insertVariable(name: string): void {
  const placeholder = `{${name}}`;
  const el = textareaRef.value;
  const current = props.prompt ?? '';
  const pos =
    el && typeof el.selectionStart === 'number' ? el.selectionStart : current.length;
  const next = current.slice(0, pos) + placeholder + current.slice(pos);
  emit('update:prompt', next);
  if (el) {
    const caret = pos + placeholder.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }
}

function onReset(): void {
  emit('reset');
}
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
        @click="onReset"
      >
        Restaurar por defecto
      </button>
    </div>

    <div class="editor-layout">
      <textarea
        :id="`phase-prompt-${step}`"
        ref="textareaRef"
        class="phase-textarea"
        :data-testid="`phase-prompt-textarea-${step}`"
        :value="prompt"
        rows="10"
        @input="onInput"
      />

      <aside class="variables-panel" :data-testid="`phase-variables-${step}`">
        <h4 class="variables-title">Variables</h4>
        <p class="variables-hint">Click para insertar en el cursor.</p>
        <ul class="chip-list">
          <li
            v-for="variable in variables"
            :key="variable.name"
            class="chip-item"
          >
            <button
              type="button"
              class="chip"
              :title="variable.description"
              :data-testid="`phase-variable-chip-${step}-${variable.name}`"
              @click="insertVariable(variable.name)"
            >
              {{ '{' + variable.name + '}' }}
            </button>
            <span class="chip-desc">{{ variable.description }}</span>
          </li>
        </ul>
      </aside>
    </div>
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

.editor-layout {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}
.phase-textarea {
  flex: 1;
  min-height: 12rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8125rem;
  padding: 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  resize: vertical;
  box-sizing: border-box;
}
.phase-textarea:focus {
  outline: 2px solid #6366f1;
  outline-offset: -1px;
}

.variables-panel {
  width: 240px;
  flex-shrink: 0;
  border-left: 1px solid #e5e7eb;
  padding-left: 0.75rem;
  max-height: 24rem;
  overflow-y: auto;
}
.variables-title {
  margin: 0 0 0.25rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #374151;
}
.variables-hint {
  margin: 0 0 0.5rem;
  font-size: 0.7rem;
  color: #6b7280;
}
.chip-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.chip-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.chip {
  align-self: flex-start;
  padding: 0.25rem 0.55rem;
  background: #eef2ff;
  color: #3730a3;
  border: 1px solid #c7d2fe;
  border-radius: 999px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  cursor: pointer;
}
.chip:hover { background: #e0e7ff; }
.chip-desc {
  font-size: 0.7rem;
  color: #6b7280;
  line-height: 1.35;
}
</style>
