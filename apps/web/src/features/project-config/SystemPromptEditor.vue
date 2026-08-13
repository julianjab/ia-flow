<script setup lang="ts">
import { computed } from 'vue';

export interface SystemPromptBlock {
  type: 'text';
  text: string;
}

const props = defineProps<{
  modelValue: SystemPromptBlock[];
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: SystemPromptBlock[]): void;
}>();

const blocks = computed(() => props.modelValue);

function updateBlockText(index: number, text: string): void {
  const next = props.modelValue.map((block, i) =>
    i === index ? { ...block, text } : block,
  );
  emit('update:modelValue', next);
}

function onInput(index: number, event: Event): void {
  const target = event.target as HTMLTextAreaElement;
  updateBlockText(index, target.value);
}

function onDragOver(event: DragEvent): void {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function onDrop(index: number, event: DragEvent): void {
  event.preventDefault();
  const payload = event.dataTransfer?.getData('text/plain') ?? '';
  if (!payload) return;
  const textarea = event.currentTarget as HTMLTextAreaElement;
  const original = props.modelValue[index]?.text ?? '';
  const pos =
    typeof textarea.selectionStart === 'number' ? textarea.selectionStart : original.length;
  const next = original.slice(0, pos) + payload + original.slice(pos);
  updateBlockText(index, next);
}
</script>

<template>
  <div class="system-prompt-editor" data-testid="system-prompt-editor">
    <div v-for="(block, index) in blocks" :key="index" class="block">
      <label class="block-label">Block {{ index + 1 }}</label>
      <textarea
        class="block-textarea"
        :data-testid="`system-prompt-block-${index}`"
        :value="block.text"
        rows="6"
        @input="onInput(index, $event)"
        @dragover="onDragOver"
        @drop="onDrop(index, $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.system-prompt-editor {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  flex: 1;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.block-label {
  font-size: 0.75rem;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.block-textarea {
  width: 100%;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875rem;
  padding: 0.5rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  resize: vertical;
  box-sizing: border-box;
}
.block-textarea:focus {
  outline: 2px solid var(--info);
  outline-offset: -1px;
}
</style>
