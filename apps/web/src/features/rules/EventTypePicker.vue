<script setup lang="ts">
import { EVENT_CATALOG } from '@ia-flow/shared'
import { computed, ref } from 'vue'

// El campo de tipos de evento: sigue siendo texto libre separado por comas,
// con las sugerencias del catálogo debajo.
//
// **No es un desplegable cerrado, y no puede serlo.** El bus no valida el tipo
// contra el catálogo: un `emit` con un tipo propio del operador, o un evento de
// un agent-host de otra versión, son configuraciones legítimas. Cerrar la lista
// las volvería imposibles de escribir.
//
// Lo que sí faltaba era saber QUÉ HAY. La descripción es la mitad del valor —
// `pr.synchronize` no le dice nada a nadie hasta que se lee "llegaron commits
// nuevos a un pull request abierto".

const model = defineModel<string>({ required: true })

const open = ref(false)

/** Lo ya elegido, para no volver a sugerirlo. */
const chosen = computed(
  () => new Set(model.value.split(',').map((t) => t.trim()).filter(Boolean)),
)

/** El último token es el que se está escribiendo: filtra por él. */
const typing = computed(() => model.value.split(',').at(-1)?.trim().toLowerCase() ?? '')

const suggestions = computed(() =>
  EVENT_CATALOG.filter((e) => !chosen.value.has(e.type)).filter(
    (e) => !typing.value || e.type.toLowerCase().includes(typing.value),
  ),
)

/** Reemplaza el token a medio escribir en vez de anexar: si alguien tipeó
 *  `pr.` y clickea `pr.opened`, lo que quiere es `pr.opened`, no
 *  `pr., pr.opened`. */
function add(type: string) {
  const parts = model.value.split(',')
  parts[parts.length - 1] = ` ${type}`
  model.value = parts.join(',').replace(/^[\s,]+/, '')
  open.value = false
}
</script>

<template>
  <div class="etp">
    <input
      v-model="model"
      class="rem-field rem-mono"
      placeholder="pr.opened, pr.synchronize"
      @focus="open = true"
    />
    <button type="button" class="etp-toggle" @click="open = !open">
      {{ open ? 'ocultar' : `ver los ${EVENT_CATALOG.length} eventos` }}
    </button>

    <div v-if="open" class="etp-list">
      <button
        v-for="e in suggestions"
        :key="e.type"
        type="button"
        class="etp-item"
        @click="add(e.type)"
      >
        <span class="etp-type">{{ e.type }}</span>
        <span class="etp-src">{{ e.source }}</span>
        <span class="etp-desc">{{ e.description }}</span>
      </button>
      <p v-if="!suggestions.length" class="etp-none">
        Ninguno conocido coincide — el valor que escribas se guarda igual.
      </p>
    </div>
  </div>
</template>

<style scoped>
.etp { display: flex; flex-direction: column; gap: 0.15rem; }
.etp-toggle {
  align-self: flex-start;
  border: 0;
  background: none;
  color: var(--info);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  cursor: pointer;
  padding: 0;
}
.etp-toggle:hover { text-decoration: underline; }
.etp-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  max-height: 15rem;
  overflow-y: auto;
  background: var(--panel);
}
.etp-item {
  display: grid;
  grid-template-columns: 13rem 4.5rem 1fr;
  /* En angosto las tres columnas suman más que la pantalla: se apilan. La
     descripción es lo que hace útil al picker, así que perderla por un
     `overflow: hidden` sería perder la razón de la lista. */
  gap: 0.5rem;
  align-items: baseline;
  text-align: left;
  border: 0;
  border-bottom: 1px solid var(--border-mute, var(--border));
  background: none;
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  padding: 0 0.6rem;
  cursor: pointer;
}
.etp-item:last-child { border-bottom: 0; }
.etp-item:hover, .etp-item:focus-visible { background: var(--panel-hi); }
.etp-type { color: var(--info); }
.etp-src { color: var(--fg-dim); }
.etp-desc { color: var(--fg-mute); white-space: normal; }
.etp-none {
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  margin: 0;
  padding: 0.3rem 0.6rem;
}

@media (max-width: 520px) {
  .etp-item {
    grid-template-columns: 1fr;
    line-height: 1.5;
    padding: 0.35rem 0.6rem;
  }
  .etp-list { max-height: 60vh; }
}
</style>