<script setup lang="ts">
// El input de filtros: un renglón que reemplaza la pila de grupos de chips.
//
// Escribís y te ofrece los CAMPOS; elegís uno y te ofrece sus VALORES; cada
// elección queda como un token que se borra solo. Las reglas de qué se sugiere y
// qué se acepta viven en `filter-query.ts` — acá está sólo la interacción.
import { computed, nextTick, ref, watch } from 'vue';
import {
  addToken,
  type FilterFieldDef,
  type FilterToken,
  formatToken,
  labelForToken,
  splitDraft,
  suggest,
  tokenFromDraft,
} from './filter-query';

const props = withDefaults(
  defineProps<{
    modelValue: FilterToken[];
    fields: FilterFieldDef[];
    placeholder?: string;
    testid?: string;
    /** Campo al que cae el texto plano (sin `:`) al confirmarlo — p.ej. `msg` en
     *  Logs, `tarea` en Ejecuciones. Sin esto, texto plano no cierra token. */
    defaultField?: string;
  }>(),
  { placeholder: 'Filtrar… (campo:valor)', testid: 'filter-query' },
);
const emit = defineEmits<{ 'update:modelValue': [FilterToken[]] }>();

const draft = ref('');
const open = ref(false);
const active = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);

const options = computed(() => suggest(draft.value, props.fields, props.modelValue));
// El menú se abre al enfocar y al escribir, pero no hay nada que mostrar en un
// campo de texto libre: `open` sola no alcanza como condición de render.
const showMenu = computed(() => open.value && options.value.length > 0);

// El índice activo se resetea con la lista: si no, una lista que se acorta al
// escribir deja resaltada una opción que ya no existe y Enter no hace nada.
watch(options, () => {
  active.value = 0;
});

function focus() {
  inputEl.value?.focus();
}

function apply(index: number) {
  const opt = options.value[index];
  if (!opt) return;
  if (opt.kind === 'field') {
    // Elegir un campo NO cierra el token: deja el `campo:` escrito y pasa a
    // ofrecer sus valores, que es el segundo paso de la misma decisión.
    draft.value = `${opt.value}:`;
    open.value = true;
    void nextTick(focus);
    return;
  }
  const { field } = splitDraft(draft.value);
  if (!field) return;
  commit(`${field}:${opt.value}`);
}

function commit(raw: string) {
  const token = tokenFromDraft(raw, props.fields, props.defaultField);
  if (!token) return;
  emit('update:modelValue', addToken(props.modelValue, token));
  draft.value = '';
  open.value = true;
  void nextTick(focus);
}

function remove(index: number) {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, i) => i !== index),
  );
}

function onEnter() {
  if (showMenu.value) {
    apply(active.value);
    return;
  }
  // Sin menú, Enter cierra lo escrito: es el camino de un campo de texto libre
  // (una fecha, un substring), donde no hay nada que elegir.
  commit(draft.value);
}

function onBackspace(ev: KeyboardEvent) {
  // Sólo con el borrador vacío: si no, borrar una letra se llevaría un token.
  if (draft.value !== '') return;
  if (props.modelValue.length === 0) return;
  ev.preventDefault();
  remove(props.modelValue.length - 1);
}

function move(delta: number) {
  if (!showMenu.value) {
    open.value = true;
    return;
  }
  const n = options.value.length;
  active.value = (active.value + delta + n) % n;
}

function onEscape() {
  if (showMenu.value) {
    open.value = false;
    return;
  }
  draft.value = '';
}

function clearAll() {
  emit('update:modelValue', []);
  draft.value = '';
  void nextTick(focus);
}
</script>

<template>
  <div class="fq" :class="{ 'fq--open': showMenu }">
    <!-- El click en cualquier parte de la caja enfoca el input: la caja SE VE
         como un campo de texto, así que tiene que comportarse como uno. -->
    <div class="fq-box" :data-testid="testid" @click="focus()">
      <button
        v-for="(token, i) in modelValue"
        :key="`${token.field}:${token.value}`"
        type="button"
        class="fq-token"
        :data-testid="`${testid}-token-${token.field}-${token.value}`"
        :title="`Quitar ${formatToken(token)}`"
        @click.stop="remove(i)"
      >
        <span class="fq-token__field">{{ token.field }}:</span>{{ labelForToken(fields, token) }}
        <span class="fq-token__x" aria-hidden="true">×</span>
      </button>
      <input
        ref="inputEl"
        v-model="draft"
        type="text"
        class="fq-input"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="showMenu"
        :placeholder="modelValue.length ? '' : placeholder"
        :data-testid="`${testid}-input`"
        @focus="open = true"
        @blur="open = false"
        @input="open = true"
        @keydown.enter.prevent="onEnter()"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.esc.prevent="onEscape()"
        @keydown.backspace="onBackspace($event)"
      />
      <button
        v-if="modelValue.length > 0"
        type="button"
        class="fq-clear"
        title="Limpiar filtros"
        :data-testid="`${testid}-clear`"
        @click.stop="clearAll()"
      >×</button>
    </div>

    <!-- `mousedown.prevent`: sin eso el blur del input cierra el menú ANTES de
         que llegue el click, y elegir con el mouse no funciona. -->
    <ul v-if="showMenu" class="fq-menu" role="listbox" :data-testid="`${testid}-menu`">
      <li
        v-for="(opt, i) in options"
        :key="`${opt.kind}:${opt.value}`"
        role="option"
        class="fq-option"
        :class="{ 'fq-option--active': i === active }"
        :aria-selected="i === active"
        :data-testid="`${testid}-option-${opt.value}`"
        @mousedown.prevent="apply(i)"
        @mouseenter="active = i"
      >
        <span class="fq-option__value">{{ opt.label }}<template v-if="opt.kind === 'field'">:</template></span>
        <span v-if="opt.hint" class="fq-option__hint">{{ opt.hint }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.fq { position: relative; }
.fq-box {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  cursor: text;
}
.fq--open .fq-box { border-color: var(--info); }
.fq-token {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.1rem 0.4rem;
  border: 1px solid var(--border-hi);
  border-radius: 4px;
  background: var(--panel-alt);
  color: var(--fg);
  font-size: 0.75rem;
  font-family: var(--mono, ui-monospace, monospace);
  cursor: pointer;
}
.fq-token:hover { border-color: var(--danger); color: var(--danger); }
.fq-token__field { color: var(--fg-dim); }
.fq-token__x { color: var(--fg-dim); }
.fq-input {
  flex: 1;
  min-width: 8rem;
  border: none;
  background: none;
  color: var(--fg);
  font-size: 0.8rem;
  padding: 0.15rem 0;
  outline: none;
}
.fq-clear {
  border: none;
  background: none;
  color: var(--fg-dim);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 0.2rem;
}
.fq-clear:hover { color: var(--danger); }

.fq-menu {
  position: absolute;
  z-index: 30;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  max-height: 15rem;
  overflow-y: auto;
  margin: 0;
  padding: 0.2rem;
  list-style: none;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  background: var(--panel);
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.12);
}
.fq-option {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.25rem 0.45rem;
  border-radius: 4px;
  font-size: 0.8rem;
  color: var(--fg);
  cursor: pointer;
}
.fq-option--active { background: var(--panel-hi); }
.fq-option__value { font-family: var(--mono, ui-monospace, monospace); }
.fq-option__hint { font-size: 0.7rem; color: var(--fg-dim); }
</style>
