<script setup lang="ts">
import { computed, ref, watch } from 'vue'

// Un `Record<string, string>` editado como filas `clave = valor`.
//
// Lo comparten los headers de `http` y el env de `script`: los dos son
// allow-lists de nombres, y editarlos como JSON crudo pedía escribir llaves y
// comillas para agregar un header.
//
// **Editar es un modo** (R11). Pasado cierto largo la lista arranca en LECTURA,
// una línea de `--row-h` por par: es grilla y no blanco táctil, porque en modo
// lectura no se toca. Con los campos montados cada fila mide `--tap-h` y veinte
// variables son 1804px de formulario que hay que scrollear entero para llegar a
// `Guardar` — cuando lo que se venía a hacer era mirar si `WOMPI_KEY` está
// puesta. Debajo del umbral no hay modo: montar los campos de tres filas no
// cuesta nada y el toggle sería un control de más.

const props = withDefaults(
  defineProps<{
    modelValue?: Record<string, string>
    keyPlaceholder?: string
    valuePlaceholder?: string
    addLabel?: string
    /** A partir de cuántas filas la lista arranca plegada en lectura. Ocho es
     *  el punto en que la lista deja de leerse de un vistazo. */
    readModeFrom?: number
    /** Los valores son secretos: en lectura se enmascaran. El modo lectura los
     *  hace visibles de un vistazo, que es exactamente lo que no se quiere de
     *  un token. */
    secret?: boolean
  }>(),
  { readModeFrom: 8, secret: false },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, string>): void
}>()

/**
 * Las filas salen del modelo en cada render, no de un `ref` propio.
 *
 * Un estado local exigía sincronizarlo con un `watch` y se desincronizaba al
 * cambiar de acción en el mismo modal. El costo es que una clave vacía no
 * sobrevive —no tiene dónde guardarse en un `Record`—, así que agregar una fila
 * escribe una clave provisoria en vez de una vacía.
 */
const rows = computed<[string, string][]>(() => Object.entries(props.modelValue ?? {}))

function push(entries: [string, string][]) {
  emit('update:modelValue', Object.fromEntries(entries))
}

function setKey(i: number, key: string) {
  const next = rows.value.map((r, idx): [string, string] => (idx === i ? [key, r[1]] : r))
  push(next)
}

function setValue(i: number, value: string) {
  push(rows.value.map((r, idx): [string, string] => (idx === i ? [r[0], value] : r)))
}

function remove(i: number) {
  push(rows.value.filter((_, idx) => idx !== i))
}

/** La clave provisoria de una fila nueva. Numerada para no pisar la anterior
 *  si se agregan dos seguidas sin escribir nada. */
function add() {
  let n = 1
  const taken = new Set(rows.value.map(([k]) => k))
  while (taken.has(`nueva-${n}`)) n++
  // Agregar entra en modo edición: no tendría sentido escribir una clave que
  // no se puede escribir.
  editing.value = true
  push([...rows.value, [`nueva-${n}`, '']])
}

/**
 * Lectura vs. edición.
 *
 * El estado arranca derivado del largo, pero es del USUARIO desde el primer
 * clic: un `computed` volvería a plegar la lista sola en cuanto se borra una
 * fila y se cruza el umbral hacia abajo, justo en medio de la edición.
 */
const editing = ref(rows.value.length <= props.readModeFrom)

// Cambiar de acción en el mismo modal reusa la instancia: sin esto, una lista
// larga se abriría editada porque la anterior era corta.
watch(
  () => props.modelValue,
  (next) => {
    if (!editing.value) return
    if (Object.keys(next ?? {}).length > props.readModeFrom && !touched.value) {
      editing.value = false
    }
  },
)
const touched = ref(false)

function startEditing() {
  touched.value = true
  editing.value = true
}

/** Lo que se lee de un valor sin montar su campo. */
function readValue(value: string): string {
  if (props.secret) return '••••••••'
  return value || '—'
}
</script>

<template>
  <div class="ff-list">
    <!-- Modo lectura: una línea de --row-h por par. Es grilla y no blanco
         táctil (R11) — acá no se toca nada, se mira. -->
    <template v-if="!editing">
      <div v-for="([key, value], i) in rows" :key="i" class="kvr-read">
        <code class="kvr-read__key">{{ key }}</code>
        <span class="kvr-read__val">{{ readValue(value) }}</span>
      </div>
      <button type="button" class="ff-add" data-testid="kvr-edit" @click="startEditing">
        editar {{ rows.length }} {{ rows.length === 1 ? 'entrada' : 'entradas' }}
      </button>
    </template>

    <template v-else>
    <div v-for="([key, value], i) in rows" :key="i" class="ff-list-row">
      <input
        class="ff-field ff-mono ff-list-key"
        :value="key"
        :placeholder="keyPlaceholder"
        @change="setKey(i, ($event.target as HTMLInputElement).value)"
      />
      <span class="ff-eq">=</span>
      <input
        class="ff-field ff-mono ff-list-val"
        :value="value"
        :placeholder="valuePlaceholder"
        @input="setValue(i, ($event.target as HTMLInputElement).value)"
      />
      <button type="button" class="ff-drop" aria-label="Quitar" @click="remove(i)">✕</button>
    </div>
    <!-- `+ <ítem>` es la ÚLTIMA FILA de la lista, no un botón suelto debajo: el
         gesto de agregar vive donde termina lo que se está leyendo, y no se
         mueve de lugar cuando la lista crece (R11). El texto nombra lo que
         agrega — `+ header`, `+ variable` — porque "+ fila" no dice de qué. -->
    <button type="button" class="ff-add" @click="add">{{ addLabel ?? '+ entrada' }}</button>
    </template>
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
/* La fila de LECTURA: --row-h, no --tap-h. Es la distinción de R11 — el blanco
   táctil es del modo edición, y aplicarlo acá duplicaría el alto de una lista
   que sólo se está mirando. */
.kvr-read {
  display: flex;
  align-items: center;
  gap: 0.6ch;
  height: var(--row-h);
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.kvr-read__key { color: var(--info); flex: 0 0 auto; }
.kvr-read__val {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-dim);
}
</style>
