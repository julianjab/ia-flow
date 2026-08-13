<script setup lang="ts">
import { ref, computed } from 'vue';

export interface VariableItem {
  label: string;
  value: string;
  hint?: string;
}

export interface VariableGroup {
  label: string;
  items: VariableItem[];
}

const props = defineProps<{
  modelValue: string;
  rows?: number;
  variableGroups: VariableGroup[];
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const search = ref('');

const filteredGroups = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return props.variableGroups;
  return props.variableGroups
    .map(group => ({
      ...group,
      items: group.items.filter(
        item => item.label.toLowerCase().includes(q) || item.hint?.toLowerCase().includes(q),
      ),
    }))
    .filter(group => group.items.length > 0);
});

const textareaEl = ref<HTMLTextAreaElement | null>(null);

function insertAtCursor(payload: string): void {
  if (!payload || !textareaEl.value) return;
  const el = textareaEl.value;
  const start = el.selectionStart ?? props.modelValue.length;
  const end = el.selectionEnd ?? start;
  const next = props.modelValue.slice(0, start) + payload + props.modelValue.slice(end);
  emit('update:modelValue', next);
  requestAnimationFrame(() => {
    const pos = start + payload.length;
    el.focus();
    el.setSelectionRange(pos, pos);
  });
}

function onChipClick(v: VariableItem): void {
  insertAtCursor(v.value);
}

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
      <input
        v-model="search"
        class="search-input"
        placeholder="Buscar…"
        autocomplete="off"
        spellcheck="false"
      />
      <div class="chips-scroll">
        <template v-if="filteredGroups.length">
          <div v-for="group in filteredGroups" :key="group.label" class="chip-group">
            <p class="chip-group-label">{{ group.label }}</p>
            <ul class="chip-list">
              <li
                v-for="v in group.items"
                :key="v.value"
                class="chip"
                :title="v.hint"
                draggable="true"
                @click="onChipClick(v)"
                @dragstart="onDragStart(v.value, $event)"
              >
                {{ v.label }}
              </li>
            </ul>
          </div>
        </template>
        <p v-else class="no-results">Sin resultados</p>
      </div>
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
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.8rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--fg);
  background: var(--panel-alt);
  resize: vertical;
  box-sizing: border-box;
  outline: none;
  line-height: 1.55;
}
.textarea:focus { border-color: var(--accent); background: var(--panel); box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }

.chips-panel {
  width: 160px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding-top: 0.1rem;
}
.chips-title {
  margin: 0 0 0.4rem 0;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-mute);
  flex-shrink: 0;
}
.search-input {
  flex-shrink: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  font-size: 0.73rem;
  color: var(--fg);
  background: var(--panel);
  outline: none;
  margin-bottom: 0.5rem;
}
.search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(37,99,235,0.1); }
.search-input::placeholder { color: var(--fg-dim); }

.chips-scroll {
  flex: 1;
  overflow-y: auto;
  max-height: 260px;
  padding-right: 2px;
}
.chips-scroll::-webkit-scrollbar { width: 4px; }
.chips-scroll::-webkit-scrollbar-track { background: transparent; }
.chips-scroll::-webkit-scrollbar-thumb { background: var(--border-hi); border-radius: 4px; }

.chip-group {
  margin-bottom: 0.65rem;
}
.chip-group-label {
  margin: 0 0 0.3rem 0;
  font-size: 0.63rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-dim);
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
  background: var(--panel-hi);
  color: var(--info);
  border: 1px solid var(--info);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.68rem;
  text-align: left;
  user-select: none;
  word-break: break-all;
  line-height: 1.4;
}
.chip:hover { background: var(--panel-hi); }
.chip:active { cursor: grabbing; }
.no-results {
  font-size: 0.72rem;
  color: var(--fg-dim);
  margin: 0.5rem 0 0;
  text-align: center;
}
</style>
