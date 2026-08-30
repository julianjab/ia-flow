<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

// Un texto largo que se lee colapsado en una línea y se edita en su lugar.
//
// Existe para un caso concreto: la descripción de una tool es un párrafo —es
// prompt del modelo, no una etiqueta— pero en un listado lo que importa es
// poder escanear los nombres. Mostrarla entera hace filas de tres renglones y
// vuelve la lista ilegible; esconderla obliga a abrir cada una para saber qué
// hace.
//
// Colapsada trunca con puntos suspensivos; abierta es un `<textarea>`, no un
// `<input>`: un párrafo en un campo de una línea sólo se puede editar por el
// extremo que se ve.

const props = defineProps<{
  modelValue: string
  placeholder?: string
  /** Filas del textarea abierto. */
  rows?: number
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'save', v: string): void
  (e: 'cancel'): void
}>()

const open = ref(false)
const draft = ref(props.modelValue)
const area = ref<HTMLTextAreaElement | null>(null)

// El borrador se resincroniza sólo mientras está cerrado: si el valor cambia
// por fuera (un refetch) mientras alguien escribe, pisarle lo tipeado sería
// perder trabajo sin aviso.
watch(
  () => props.modelValue,
  (v) => {
    if (!open.value) draft.value = v
  },
)

async function abrir() {
  if (props.disabled) return
  draft.value = props.modelValue
  open.value = true
  await nextTick()
  area.value?.focus()
  // El cursor al final y no seleccionando todo: lo más común es ajustar el
  // final de una frase, no reemplazarla entera.
  const n = draft.value.length
  area.value?.setSelectionRange(n, n)
}

function guardar() {
  const v = draft.value.trim()
  if (!v) return
  open.value = false
  emit('update:modelValue', v)
  emit('save', v)
}

function cancelar() {
  draft.value = props.modelValue
  open.value = false
  emit('cancel')
}

/**
 * Enter hace salto de línea; se guarda con Cmd/Ctrl+Enter.
 *
 * Es al revés que en un input de una línea, y tiene que serlo: el valor es un
 * párrafo, así que si Enter guardara no habría forma de escribir el segundo
 * renglón.
 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    cancelar()
    return
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    guardar()
  }
}
</script>

<template>
  <div class="ie" :class="{ 'ie--open': open }">
    <button
      v-if="!open"
      type="button"
      class="ie-collapsed"
      :class="{ 'ie-collapsed--empty': !modelValue, 'ie-collapsed--ro': disabled }"
      :disabled="disabled"
      :title="modelValue || placeholder"
      @click="abrir"
    >
      {{ modelValue || placeholder || '—' }}
    </button>

    <div v-else class="ie-open">
      <textarea
        ref="area"
        v-model="draft"
        class="ie-area"
        :rows="rows ?? 4"
        :placeholder="placeholder"
        @keydown="onKeydown"
      />
      <div class="ie-ops">
        <span class="ie-hint">⌘↵ guarda · esc cancela</span>
        <span class="ie-sp" />
        <!-- Los botones del sistema (`.btn`), no una caja propia: éste es el
             pie de un formulario editable igual que el del catálogo MCP o el
             de una acción, y cuando cada uno se dibujaba el suyo el mismo par
             Cancelar/Guardar tenía tres tamaños distintos según la pantalla. -->
        <button type="button" class="btn" @click="cancelar">Cancelar</button>
        <button type="button" class="btn btn--primary" :disabled="!draft.trim()" @click="guardar">
          Guardar
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ie { min-width: 0; flex: 1; }

/* Colapsada: UNA línea, truncada. `min-width: 0` porque como hijo de un flex su
   mínimo sería el del texto y estiraría la fila entera. */
.ie-collapsed {
  display: block;
  width: 100%;
  min-width: 0;
  text-align: left;
  border: 0;
  background: none;
  padding: 0;
  color: var(--fg-mute);
  font-family: inherit;
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.ie-collapsed:hover:not(:disabled) { color: var(--fg); }
.ie-collapsed--empty { color: var(--fg-dim); font-style: italic; }
.ie-collapsed--ro { cursor: default; }

.ie-open { display: flex; flex-direction: column; gap: 0.25rem; width: 100%; }
.ie-area {
  width: 100%;
  box-sizing: border-box;
  padding: 0.35rem 0.5ch;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--panel-alt);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  line-height: 1.5;
  resize: vertical;
}
.ie-ops {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  /* Envuelven antes que salirse: en angosto los dos botones mas el hint no
     entran en una linea. */
  flex-wrap: wrap;
}
.ie-sp { flex: 1; }
.ie-hint {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}

@media (max-width: 640px) {
  /* El hint del atajo no aplica sin teclado. */
  .ie-hint { display: none; }
}
</style>
