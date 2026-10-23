<script setup lang="ts">
import { RATES, useVoiceStore } from '@/features/assistant/voice/voiceStore';
import BottomSheet from '@/ui/BottomSheet.vue';

// La voz del asistente, en un sheet: leer en voz alta, la charla, con qué voz y a qué velocidad.
// Es configuración —se elige una vez, no en cada mensaje—, así que no ocupa una fila fija debajo
// de la caja de pregunta: se abre desde 🔈 de la cabecera o desde el chip de voz del composer.

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const voice = useVoiceStore();
</script>

<template>
  <BottomSheet :open="open" title="Voz del asistente" @close="emit('close')">
    <div class="vs">
      <label class="vs__row">
        <span class="vs__txt">
          <span class="vs__name">Leer las respuestas</span>
          <span class="vs__hint">Cada respuesta se lee al terminar.</span>
        </span>
        <input type="checkbox" class="vs__switch" data-test="read" :checked="voice.read" @change="voice.toggleRead()" />
      </label>
      <label v-if="voice.talkSupported" class="vs__row">
        <span class="vs__txt">
          <span class="vs__name">Charla</span>
          <span class="vs__hint">Después de leer, vuelve a escuchar: hablás sin tocar nada.</span>
        </span>
        <input type="checkbox" class="vs__switch" data-test="talk" :checked="voice.talk" @change="voice.toggleTalk()" />
      </label>
      <label v-if="voice.voices.length > 1" class="vs__field">
        <span class="vs__name">Voz</span>
        <select
          id="assistant-voice"
          class="vs__select"
          data-test="voice-pick"
          :value="voice.voice?.id"
          @change="voice.chooseVoice(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="v in voice.voices" :key="v.id" :value="v.id">{{ v.name }} · {{ v.lang }}</option>
        </select>
      </label>
      <div class="vs__field" role="group" aria-label="Velocidad de lectura">
        <span class="vs__name">Velocidad</span>
        <div class="vs__rates">
          <button
            v-for="r in RATES"
            :key="r"
            type="button"
            class="vs__rate"
            :data-test="`rate-${r}`"
            :aria-pressed="voice.rate === r"
            @click="voice.setRate(r)"
          >
            {{ r }}×
          </button>
        </div>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.vs { display: flex; flex-direction: column; gap: 0.25rem; padding: 0 1rem; }
.vs__row { display: flex; align-items: center; gap: 0.75rem; min-height: var(--tap-h-lg); border-bottom: 1px solid var(--border-mute); cursor: pointer; }
.vs__txt { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.vs__name { color: var(--fg); font-size: var(--fs-body); }
.vs__hint { color: var(--fg-dim); font-size: var(--fs-chrome); }
/* El interruptor es el checkbox nativo con otra piel: sigue siendo un checkbox para el lector. */
.vs__switch {
  flex: none;
  position: relative;
  width: 2.5rem;
  height: 1.45rem;
  margin: 0;
  border-radius: 1rem;
  background: var(--panel-hi);
  appearance: none;
  cursor: pointer;
  transition: background 150ms;
}
.vs__switch::after {
  content: '';
  position: absolute;
  top: 0.2rem;
  left: 0.2rem;
  width: 1.05rem;
  height: 1.05rem;
  border-radius: 50%;
  background: var(--fg-dim);
  transition: transform 150ms, background 150ms;
}
.vs__switch:checked { background: var(--accent); }
.vs__switch:checked::after { background: var(--bg); transform: translateX(1.05rem); }
.vs__switch:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.vs__field { display: flex; flex-direction: column; gap: 0.35rem; padding-top: 0.6rem; }
.vs__select { min-height: var(--tap-h); }
.vs__rates { display: flex; gap: 0.4rem; }
.vs__rate {
  flex: 1;
  min-height: var(--tap-h);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: none;
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.vs__rate:hover { border-color: var(--border-hi); color: var(--fg); }
.vs__rate[aria-pressed='true'] { border-color: var(--border-hi); background: var(--panel-top); color: var(--fg); }
@media (prefers-reduced-motion: reduce) {
  .vs__switch,
  .vs__switch::after { transition: none; }
}
</style>
