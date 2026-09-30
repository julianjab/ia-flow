<script setup lang="ts">
import type { AssistantScope, InboxItem, InboxProject } from '@ia-flow/shared';
import { computed, ref } from 'vue';
import { dropScopeQuery, scopeQuery, typedRef } from '@/features/assistant/scope';
import ScopeTag from '@/features/assistant/ScopeTag.vue';

// La caja de pregunta, con el contexto de la conversación encima: una chip que se
// cambia tocándola o escribiendo `#` (una tarea) o `@` (un proyecto, o `general`).
// Enter envía, Shift+Enter baja de línea; con la lista de contextos abierta, las
// flechas y Enter eligen. Mientras responde, «Enviar» pasa a «Detener».

const props = defineProps<{
  placeholder: string;
  streaming: boolean;
  scope: AssistantScope;
  tasks: InboxItem[];
  projects: InboxProject[];
}>();
const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'stop'): void;
  (e: 'scope', scope: AssistantScope): void;
}>();

const text = ref('');
const input = ref<HTMLTextAreaElement | null>(null);
const at = ref(0);
const closed = ref(false);

interface Option {
  scope: AssistantScope;
  label: string;
  hint: string;
}

const options = computed<Option[]>(() => {
  const q = scopeQuery(text.value);
  if (!q || closed.value) return [];
  if (q.sigil === '@') {
    return [
      { scope: { kind: 'general' as const }, label: 'general', hint: 'todo el runner' },
      ...props.projects.map((p) => ({ scope: { kind: 'project' as const, project_id: p.id }, label: p.id, hint: 'proyecto' })),
    ].filter((o) => o.label.toLowerCase().includes(q.query));
  }
  const found: Option[] = props.tasks
    .filter((t) => t.ref.toLowerCase().includes(q.query) || t.title.toLowerCase().includes(q.query))
    .slice(0, 8)
    .map((t) => ({ scope: { kind: 'task', ref: t.ref }, label: t.ref, hint: t.title }));
  // Una ref escrita entera vale aunque no esté en la bandeja (el runner dice si existe).
  const typed = typedRef(q.query);
  if (typed && !found.some((o) => o.label.toLowerCase() === typed)) {
    found.unshift({ scope: { kind: 'task', ref: typed }, label: typed, hint: 'la ref escrita' });
  }
  return found;
});

function choose(option: Option | undefined) {
  if (!option) return;
  text.value = dropScopeQuery(text.value);
  emit('scope', option.scope);
  input.value?.focus();
}

function openPicker() {
  closed.value = false;
  text.value = text.value && !text.value.endsWith(' ') ? `${text.value} #` : `${text.value}#`;
  at.value = 0;
  input.value?.focus();
}

function onInput() {
  closed.value = false;
  at.value = 0;
}

function submit() {
  const value = text.value.trim();
  if (!value || scopeQuery(value)?.query === '') return;
  emit('send', value);
  text.value = '';
}

function onKeydown(e: KeyboardEvent) {
  if (options.value.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = options.value.length;
      at.value = (at.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      choose(options.value[at.value]);
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      closed.value = true;
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <form class="co" @submit.prevent="submit">
    <!-- La lista de contextos va en el flujo, arriba de la caja (R6: nada flota anclado). -->
    <ul v-if="options.length" class="co__opts" role="listbox" aria-label="Contexto de la conversación">
      <li v-for="(o, i) in options" :key="o.label" role="option" :aria-selected="i === at">
        <button type="button" class="co__opt" :data-test="`opt-${o.label}`" @mousedown.prevent @click="choose(o)">
          <ScopeTag :scope="o.scope" />
          <span class="co__hint">{{ o.hint }}</span>
        </button>
      </li>
    </ul>

    <p class="co__ctx">
      <span class="co__lbl">Contexto</span>
      <button type="button" class="co__chip" data-test="scope" aria-label="Cambiar el contexto" @click="openPicker">
        <ScopeTag :scope="scope" /> <span class="co__caret" aria-hidden="true">▾</span>
      </button>
      <span class="co__lbl">· <span class="mono">#</span> tarea · <span class="mono">@</span> proyecto</span>
    </p>

    <div class="co__row">
      <label class="co__label" for="assistant-input">Tu pregunta</label>
      <textarea
        id="assistant-input"
        ref="input"
        v-model="text"
        class="co__input"
        rows="2"
        :placeholder="placeholder"
        @input="onInput"
        @keydown="onKeydown"
      />
      <button v-if="streaming" type="button" class="btn co__btn" data-test="stop" @click="emit('stop')">Detener</button>
      <button v-else type="submit" class="btn btn--primary co__btn" :disabled="!text.trim()">Enviar</button>
    </div>
  </form>
</template>

<style scoped>
.co { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
.co__opts { max-height: 12rem; margin: 0; padding: 0; overflow-y: auto; border: 1px solid var(--border-hi); border-radius: var(--radius); background: var(--panel); list-style: none; }
.co__opts li + li { border-top: 1px solid var(--border-mute); }
.co__opt { display: flex; align-items: center; gap: 0.5rem; width: 100%; min-height: var(--tap-h); padding: 0.3rem 0.6rem; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.co__opts li[aria-selected='true'] .co__opt,
.co__opt:hover { background: var(--panel-hi); }
.co__hint { min-width: 0; overflow: hidden; color: var(--fg-mute); font-size: var(--fs-chrome); text-overflow: ellipsis; white-space: nowrap; }
.co__ctx { display: flex; flex-wrap: wrap; align-items: center; gap: 0.1rem 0.4rem; margin: 0; }
.co__lbl { color: var(--fg-dim); font-size: var(--fs-chrome); }
.co__chip { display: inline-flex; align-items: center; gap: 0.2rem; max-width: 100%; min-height: var(--tap-h-sm); padding: 0 0.25rem; border: 1px solid transparent; border-radius: var(--radius-sm); background: none; cursor: pointer; }
.co__chip:hover { border-color: var(--border-hi); }
.co__caret { color: var(--fg-dim); font-size: var(--fs-micro); }
.co__row { display: flex; align-items: flex-end; gap: 0.5rem; min-width: 0; }
.co__label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.co__input { flex: 1; min-width: 0; resize: none; font-family: var(--font-body); line-height: 1.4; }
.co__btn { flex: none; }
</style>
