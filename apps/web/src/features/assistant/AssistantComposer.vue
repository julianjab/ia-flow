<script setup lang="ts">
import { ref } from 'vue';

// La caja de pregunta. Enter envía, Shift+Enter baja de línea. Mientras el
// asistente responde, «Enviar» pasa a «Detener» (corta el stream; lo que ya
// llegó se queda).

defineProps<{ placeholder: string; streaming: boolean }>();
const emit = defineEmits<{ (e: 'send', text: string): void; (e: 'stop'): void }>();

const text = ref('');

function submit() {
  const value = text.value.trim();
  if (!value) return;
  emit('send', value);
  text.value = '';
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <form class="co" @submit.prevent="submit">
    <label class="co__label" for="assistant-input">Tu pregunta</label>
    <textarea
      id="assistant-input"
      v-model="text"
      class="co__input"
      rows="2"
      :placeholder="placeholder"
      @keydown="onKeydown"
    />
    <button v-if="streaming" type="button" class="btn co__btn" data-test="stop" @click="emit('stop')">
      Detener
    </button>
    <button v-else type="submit" class="btn btn--primary co__btn" :disabled="!text.trim()">Enviar</button>
  </form>
</template>

<style scoped>
.co { display: flex; align-items: flex-end; gap: 0.5rem; min-width: 0; }
.co__label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.co__input { flex: 1; min-width: 0; resize: none; font-family: var(--font-body); line-height: 1.4; }
.co__btn { flex: none; }
</style>
