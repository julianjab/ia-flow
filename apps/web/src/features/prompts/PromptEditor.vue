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
  // El textarea pasa de altura fija (`rows`) a ocupar todo lo que el
  // contenedor flex le dé — ver PromptField `fill` para el porqué.
  fill?: boolean;
  variableGroups: VariableGroup[];
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const search = ref('');

// Variables realmente usadas en el prompt actual — sustituye "KEY" (los
// placeholders tipo {{variables.KEY}}) por un patrón libre antes de
// buscar, así {{variables.MI_KEY}} matchea el item genérico del catálogo.
function usagePattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace('KEY', '[A-Za-z0-9_]+'));
}

function isUsed(value: string): boolean {
  if (!props.modelValue) return false;
  return usagePattern(value).test(props.modelValue);
}

const usedItems = computed(() =>
  props.variableGroups.flatMap((group) => group.items.filter((item) => isUsed(item.value))),
);

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
  <div class="prompt-editor" :class="{ 'prompt-editor--fill': fill }">
    <textarea
      ref="textareaEl"
      class="textarea"
      :class="{ 'textarea--fill': fill }"
      :rows="rows ?? 6"
      :value="modelValue"
      placeholder="./prompts/mi-prompt.md  o texto del prompt aquí…"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @dragover="onDragOver"
      @drop="onDrop"
    />
    <aside class="chips-panel">
      <p class="chips-title">Variables</p>

      <div v-if="usedItems.length" class="used-strip">
        <span class="used-strip-lbl">usadas acá</span>
        <span v-for="v in usedItems" :key="v.value" class="used-chip" :title="v.hint">{{ v.label }}</span>
      </div>

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
                :class="{ 'chip--used': isUsed(v.value) }"
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
.prompt-editor--fill {
  flex: 1;
  min-height: 0;
  max-height: 28rem;
  align-items: stretch;
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
.textarea--fill {
  height: 100%;
  max-height: 28rem;
  resize: none;
}

.chips-panel {
  width: 190px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding-top: 0.1rem;
}

.used-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
  padding: 0.4rem 0.5rem;
  margin-bottom: 0.5rem;
  background: var(--green-bg);
  border: 1px solid var(--accent);
  border-radius: 5px;
}
.used-strip-lbl {
  width: 100%;
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--accent);
}
.used-chip {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  color: var(--fg);
  background: var(--panel-hi);
  border-radius: 4px;
  padding: 0.1rem 0.35rem;
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
.prompt-editor--fill .chips-scroll {
  max-height: none;
  min-height: 0;
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
.chip--used {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.no-results {
  font-size: 0.72rem;
  color: var(--fg-dim);
  margin: 0.5rem 0 0;
  text-align: center;
}

@media (max-width: 640px) {
  /* El panel de variables mide 190px fijos al lado del textarea: en 390px eso
     deja el prompt en ~150px de ancho, o sea cuatro palabras por línea. Se
     apila — el prompt primero, que es lo que se está escribiendo, y las
     variables abajo (el chip inserta con click, no sólo arrastrando, así que
     no pierden nada al no estar al lado). */
  .prompt-editor { flex-direction: column; align-items: stretch; }
  .chips-panel { width: auto; }
  /* Sin tope, la lista completa de variables empuja el resto del formulario
     fuera de la pantalla; con `--fill` lo hereda del contenedor, que acá ya
     no existe porque no hay dos columnas que igualar. */
  .prompt-editor--fill { max-height: none; }
  .prompt-editor--fill .chips-scroll { max-height: 260px; }
  /* Las variables se ven mejor en filas cortas que en una columna angosta. */
  .chip-list { flex-direction: row; flex-wrap: wrap; }
}
</style>
