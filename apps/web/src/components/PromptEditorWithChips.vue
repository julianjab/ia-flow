<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ modelValue: string; rows?: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const VARIABLES = [
  { label: '{{task.title}}',         value: '{{task.title}}' },
  { label: '{{task.description}}',   value: '{{task.description}}' },
  { label: '{{task.type}}',          value: '{{task.type}}' },
  { label: '{{task.repos}}',         value: '{{task.repos}}' },
  { label: '{{context.repos}}',      value: '{{context.repos}}' },
  { label: '{{variables.key}}',      value: '{{variables.key}}' },
  { label: '{{task.sections.name}}', value: '{{task.sections.name}}' },
];

const textareaEl = ref<HTMLTextAreaElement | null>(null);

function onDragStart(variable: string, event: DragEvent): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData('text/plain', variable);
  event.dataTransfer.effectAllowed = 'copy';
}

function onDragOver(event: DragEvent): void {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  const payload = event.dataTransfer?.getData('text/plain') ?? '';
  if (!payload || !textareaEl.value) return;

  const el = textareaEl.value;
  const start = el.selectionStart ?? props.modelValue.length;
  const end = el.selectionEnd ?? start;
  const next = props.modelValue.slice(0, start) + payload + props.modelValue.slice(end);
  emit('update:modelValue', next);

  // restore cursor after the inserted text
  requestAnimationFrame(() => {
    const pos = start + payload.length;
    el.focus();
    el.setSelectionRange(pos, pos);
  });
}
</script>

<template>
  <div class="prompt-editor">
    <textarea
      ref="textareaEl"
      class="textarea"
      :rows="rows ?? 6"
      :value="modelValue"
      placeholder="./prompts/mi-prompt.md  o texto del prompt aquí…"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @dragover="onDragOver"
      @drop="onDrop"
    />
    <aside class="chips-panel">
      <p class="chips-title">Variables</p>
      <p class="chips-hint">Arrastra sobre el prompt.</p>
      <ul class="chip-list">
        <li
          v-for="v in VARIABLES"
          :key="v.value"
          class="chip"
          draggable="true"
          @dragstart="onDragStart(v.value, $event)"
        >
          {{ v.label }}
        </li>
      </ul>
    </aside>
  </div>
</template>

<style scoped>
.prompt-editor {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}
.textarea {
  flex: 1;
  min-width: 0;
  padding: 0.5rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.8rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: #1e293b;
  background: #f8fafc;
  resize: vertical;
  box-sizing: border-box;
  outline: none;
  line-height: 1.55;
}
.textarea:focus { border-color: #2563eb; background: #fff; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
.textarea[dragover] { border-color: #2563eb; background: #eff6ff; }

.chips-panel {
  width: 160px;
  flex-shrink: 0;
  padding-top: 0.1rem;
}
.chips-title {
  margin: 0 0 0.15rem 0;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #374151;
}
.chips-hint {
  margin: 0 0 0.5rem 0;
  font-size: 0.68rem;
  color: #9ca3af;
  line-height: 1.3;
}
.chip-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.chip {
  cursor: grab;
  padding: 0.25rem 0.45rem;
  background: #eef2ff;
  color: #3730a3;
  border: 1px solid #c7d2fe;
  border-radius: 999px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.68rem;
  text-align: center;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip:active { cursor: grabbing; }
</style>
