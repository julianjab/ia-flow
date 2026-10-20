<script setup lang="ts">
import type { AssistantScope, InboxItem, InboxProject } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';
import { dropScopeQuery, scopeQuery, typedRef } from '@/features/assistant/scope';
import ScopeTag from '@/features/assistant/ScopeTag.vue';
import { browserDictation } from '@/features/assistant/voice/speech';
import { useDictation } from '@/features/assistant/voice/useDictation';
import { useVoiceStore } from '@/features/assistant/voice/voiceStore';

// La caja de pregunta: UNA caja con el texto arriba y su barra abajo —el contexto
// (una chip que se cambia tocándola o escribiendo `#` una tarea o `@` un proyecto,
// o `general`), la voz si está prendida, 🎤 y enviar—. Enter envía, Shift+Enter
// baja de línea; con la lista de contextos abierta, las flechas y Enter eligen.
// Enviar y Detener son el mismo botón redondo, en el mismo lugar. 🎤 dicta (si el
// navegador sabe): lo dicho se suma a la caja; terminar con «enviar» o quedarse
// 4 s callado la manda (mientras responde, sólo queda escrita). En charla, el
// micrófono se abre solo cuando la voz termina de leer. La voz y su velocidad se
// eligen en un sheet (`voice`), no en una fila fija debajo.

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
  (e: 'voice'): void;
}>();

const dictation = useDictation(browserDictation());
const voice = useVoiceStore();

function listen() {
  // Lo que se esté leyendo se calla: el micrófono no tiene que escuchar a la voz.
  voice.cancel();
  dictation.start(text.value, {
      write: (value) => (text.value = value),
      send: (value) => {
        text.value = value;
        // Con una respuesta en curso no se puede preguntar: queda en la caja para mandarla después.
        if (!props.streaming) submit();
      },
    });
}

function toggleDictation() {
  if (dictation.listening.value) dictation.stop();
  else listen();
}

// La charla pide escuchar (al prenderla, o cuando la voz termina de leer una respuesta).
watch(
  () => voice.listenTick,
  () => {
    if (dictation.supported && !dictation.listening.value && !props.streaming) listen();
  },
);
// Apagar la charla corta lo que se estaba dictando por ella.
watch(
  () => voice.talk,
  (on) => {
    if (!on && dictation.listening.value) dictation.stop();
  },
);

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
  dictation.stop();
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

    <div class="co__box" :data-live="dictation.listening.value">
      <label class="co__label" for="assistant-input">Tu pregunta</label>
      <textarea
        id="assistant-input"
        ref="input"
        v-model="text"
        class="co__input"
        rows="1"
        :placeholder="placeholder"
        @input="onInput"
        @keydown="onKeydown"
      />
      <div class="co__bar">
        <button type="button" class="co__chip" data-test="scope" aria-label="Cambiar el contexto" @click="openPicker">
          <ScopeTag :scope="scope" /> <span class="co__caret" aria-hidden="true">▾</span>
        </button>
        <button
          v-if="voice.wantsSpeech"
          type="button"
          class="co__chip co__voice"
          data-test="rate"
          :aria-label="`Voz: ${voice.voice?.name ?? 'la del sistema'}, a ${voice.rate}×. Cambiar`"
          @click="emit('voice')"
        >
          {{ voice.voice?.lang.slice(0, 2).toUpperCase() ?? 'ES' }} · {{ voice.rate }}×
        </button>
        <span class="co__grow" />
        <button
          v-if="dictation.supported"
          type="button"
          class="co__icon co__mic"
          data-test="mic"
          :aria-pressed="dictation.listening.value"
          :aria-label="dictation.listening.value ? 'Dejar de dictar' : 'Dictar la pregunta'"
          :title="dictation.listening.value ? 'Dejar de dictar' : 'Dictar la pregunta (terminá con «enviar» o quedate callado 4 s)'"
          @click="toggleDictation"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></svg>
        </button>
        <button v-if="streaming" type="button" class="co__send co__send--stop" data-test="stop" aria-label="Detener" title="Detener" @click="emit('stop')">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
        </button>
        <button v-else type="submit" class="co__send" data-test="send" aria-label="Enviar" title="Enviar" :disabled="!text.trim()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
        </button>
      </div>
    </div>
    <p v-if="dictation.listening.value" class="co__listening" data-test="mic-hint">
      <span class="co__rec" aria-hidden="true">●</span> Escuchando · decí «enviar» o hacé una pausa de 4 s
    </p>
    <p v-else-if="dictation.error.value" class="co__err" role="alert" data-test="mic-error">✕ {{ dictation.error.value }}</p>
  </form>
</template>

<style scoped>
.co { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
.co__opts { max-height: 12rem; margin: 0; padding: 0; overflow-y: auto; border: 1px solid var(--border-hi); border-radius: var(--radius); background: var(--panel); list-style: none; }
.co__opts li + li { border-top: 1px solid var(--border-mute); }
.co__opt { display: flex; align-items: center; gap: 0.5rem; width: 100%; min-height: var(--tap-h); padding: 0.3rem 0.6rem; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.co__opts li[aria-selected='true'] .co__opt,
.co__opt:hover { background: var(--panel-hi); }
.co__hint { min-width: 0; overflow: hidden; color: var(--fg-mute); font-size: var(--fs-chrome); text-overflow: ellipsis; white-space: nowrap; }
/* La caja: el texto y su barra son UN objeto. El radio ×3 es el de las burbujas del hilo. */
.co__box {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) * 3);
  background: var(--panel-alt);
  transition: border-color 150ms;
}
.co__box:focus-within { border-color: var(--border-hi); }
.co__box[data-live='true'] { border-color: var(--danger); }
.co__label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.co__input {
  min-height: 2.6rem;
  max-height: 9rem;
  padding: 0.6rem 0.8rem 0.2rem;
  border: 0;
  background: none;
  resize: none;
  field-sizing: content;
  font-family: var(--font-body);
  line-height: 1.4;
}
.co__input:focus { outline: none; box-shadow: none; }
.co__bar { display: flex; align-items: center; gap: 0.25rem; min-width: 0; padding: 0.2rem 0.3rem 0.3rem; }
.co__grow { flex: 1; }
.co__chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  max-width: 60%;
  min-height: var(--tap-h-sm);
  padding: 0 0.6rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: none;
  color: var(--fg-mute);
  cursor: pointer;
}
.co__chip:hover { border-color: var(--border-hi); color: var(--fg); }
.co__caret { color: var(--fg-dim); font-size: var(--fs-micro); }
.co__voice { flex: none; font-family: var(--font-mono); font-size: var(--fs-chrome); font-variant-numeric: tabular-nums; }
.co__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: var(--tap-h);
  height: var(--tap-h);
  border: 0;
  border-radius: 50%;
  background: none;
  color: var(--fg-mute);
  cursor: pointer;
}
.co__icon svg { width: 1.2rem; height: 1.2rem; }
.co__icon:hover { background: var(--panel-hi); color: var(--fg); }
.co__mic[aria-pressed='true'] { background: var(--red-bg); color: var(--danger); }
/* Enviar y Detener: el mismo círculo en el mismo lugar, para que el pulgar no lo busque. */
.co__send {
  flex: none;
  display: grid;
  place-items: center;
  width: var(--tap-h);
  height: var(--tap-h);
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  color: var(--bg);
  cursor: pointer;
}
.co__send svg { width: 1.1rem; height: 1.1rem; }
.co__send:hover { background: var(--green-hi); }
.co__send:disabled { background: var(--panel-hi); color: var(--fg-dimmer); cursor: default; }
.co__send--stop { background: var(--fg); }
.co__send--stop:hover { background: var(--fg-mute); }
.co__listening { margin: 0; padding-left: 0.5rem; color: var(--fg-dim); font-size: var(--fs-chrome); }
.co__rec { color: var(--danger); }
.co__err { margin: 0; padding-left: 0.5rem; color: var(--danger); font-size: var(--fs-chrome); }
@media (prefers-reduced-motion: reduce) {
  .co__box { transition: none; }
}
</style>
