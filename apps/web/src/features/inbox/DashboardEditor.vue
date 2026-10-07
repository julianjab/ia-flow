<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useInboxStore } from '@/features/inbox/store';

// El dashboard de ESTE runner, editable: lo que alguien edita queda en este navegador y pisa al que
// trae la web; «Volver al de la web» lo suelta. Un documento que no cumple el formato no se guarda
// y dice dónde falla.

const store = useInboxStore();

const SOURCE_COPY = {
  override: 'editado para este runner (guardado en este navegador)',
  preset: 'el que trae la web para este runner',
  default: 'el de defecto de la web',
} as const;

const text = ref('');
const problem = ref<string | null>(null);
const saved = ref(false);

const resolved = computed(() => store.dashboard);
watch(
  resolved,
  (next) => {
    // No pisa lo que se está escribiendo: sólo carga cuando cambia de dónde sale el dashboard.
    if (next && (text.value === '' || !dirty.value)) text.value = next.text;
  },
  { immediate: true },
);

const dirty = computed(() => resolved.value !== null && text.value !== resolved.value.text);

function save() {
  saved.value = false;
  problem.value = store.saveDashboard(text.value);
  saved.value = problem.value === null;
}

function reset() {
  store.resetDashboard();
  problem.value = null;
  saved.value = false;
  text.value = store.dashboard?.text ?? '';
}
</script>

<template>
  <div v-if="resolved" class="de">
    <p class="de__src">
      Dashboard de este runner: <strong>{{ SOURCE_COPY[resolved.source] }}</strong>
    </p>
    <p v-if="resolved.warning" class="de__err" role="alert">✕ {{ resolved.warning }}</p>
    <label class="uc-label" for="dashboard-text">dashboard (YAML)</label>
    <textarea
      id="dashboard-text"
      v-model="text"
      class="de__text mono"
      rows="14"
      spellcheck="false"
      :aria-invalid="problem !== null"
    />
    <p v-if="problem" class="de__err" role="alert">✕ {{ problem }}</p>
    <p v-else-if="saved" class="de__ok" role="status">✓ Guardado: la bandeja ya lo usa.</p>
    <div class="de__row">
      <button v-if="resolved.source === 'override'" type="button" class="btn" @click="reset">
        Volver al de la web
      </button>
      <!-- Neutro: el primario de la pantalla es el de «Lo primero», y éste vive en la misma. -->
      <button type="button" class="btn" data-test="save" :disabled="!dirty" @click="save">Guardar</button>
    </div>
  </div>
</template>

<style scoped>
.de { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.5rem 0 0.75rem; }
.de__src { margin: 0; color: var(--fg-mute); font-size: var(--fs-body-sm); }
.de__text {
  width: 100%;
  min-height: 12rem;
  resize: vertical;
  font-size: var(--fs-body-sm);
  line-height: 1.45;
}
.de__err { margin: 0; color: var(--danger); font-size: var(--fs-body-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
.de__ok { margin: 0; color: var(--accent); font-size: var(--fs-body-sm); }
.de__row { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; }
</style>
