<script setup lang="ts">
import { computed, ref } from 'vue';
import { shortRef } from '@/features/inbox/queue/shortRef';
import { useAssistantStore } from '@/stores/assistant';

// La caja para preguntarle al asistente sobre ESTA tarea, al pie del detalle y siempre a mano (antes
// era un link entre las corridas y las acciones, a una pantalla de scroll). Lo escrito se manda al
// abrir el asistente, ya en el contexto de la tarea; vacía, sólo lo abre en ese contexto.

const props = defineProps<{ taskRef: string }>();

const assistant = useAssistantStore();
const text = ref('');
const short = computed(() => shortRef(props.taskRef));

function send() {
  assistant.open({ kind: 'task', ref: props.taskRef }, text.value);
  text.value = '';
}
</script>

<template>
  <form class="ask" data-test="ask" @submit.prevent="send">
    <span class="ask__ai" aria-hidden="true">✦</span>
    <input
      v-model="text"
      class="ask__input"
      type="text"
      enterkeyhint="send"
      autocomplete="off"
      :placeholder="`Preguntale sobre ${short}…`"
      :aria-label="`Preguntale al asistente sobre ${short}`"
    />
    <button
      type="submit"
      class="ask__send"
      :aria-label="text.trim() ? 'Enviar al asistente' : 'Abrir el asistente'"
      :data-ready="Boolean(text.trim())"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
    </button>
  </form>
</template>

<style scoped>
/* La misma forma que la caja de pregunta del asistente: una píldora con ✦ y el envío redondo. */
.ask {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-height: var(--tap-h);
  padding: 0 0.2rem 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-alt);
}
.ask:focus-within { border-color: var(--ai); }
.ask__ai { flex: none; color: var(--ai); }
.ask__input {
  flex: 1;
  min-width: 0;
  height: var(--tap-h);
  border: 0;
  background: none;
  color: var(--fg);
  font: inherit;
  font-size: var(--fs-input);
}
.ask__input::placeholder { color: var(--fg-dim); }
.ask__input:focus { outline: none; }
.ask__send {
  flex: none;
  display: grid;
  place-items: center;
  width: calc(var(--tap-h) - 0.4rem);
  height: calc(var(--tap-h) - 0.4rem);
  border: 0;
  border-radius: 50%;
  background: var(--panel-hi);
  color: var(--fg-mute);
  cursor: pointer;
}
.ask__send[data-ready='true'] { background: var(--accent); color: var(--panel); }
.ask__send svg { width: 1.1rem; height: 1.1rem; }
.ask__send:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
</style>
