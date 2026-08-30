<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

// El campo de selección de la app: uno solo para las tres formas que había
// sueltas.
//
// Antes existían tres componentes con la misma idea y comportamientos distintos:
// `AutocompleteSelect` (uno, texto libre), `SlackMemberMultiSelect` (varios con
// chips, sin texto libre) y `SlackChannelField` (uno, texto libre, con su propio
// dropdown). Tres teclados distintos, tres estilos de dropdown, tres formas de
// decir "sin resultados" — y la que uses depende de en qué pantalla caíste.
//
// Las tres son la MISMA pregunta con dos ejes:
//
//                     │ acepta sólo lo listado │ acepta cualquier valor
//   ──────────────────┼────────────────────────┼───────────────────────
//   un valor          │  agente, repo          │  canal de Slack
//   varios (chips)    │  reviewers             │  tipos de evento
//
// Así que son dos props (`multiple`, `allowCustom`), no cuatro componentes.

export interface ComboOption {
  value: string
  /** Lo que se muestra. Default: el `value`. */
  label?: string
  /** Texto secundario a la derecha — un id, un tipo, una descripción corta.
   *  Es lo que hace elegible una lista de nombres opacos. */
  hint?: string
  /** Un glifo al principio, del set del design system (● ○ ◆ ✦ …). */
  glyph?: string
  /** Tooltip del chip. Es donde va el dato que identifica sin ocupar ancho —
   *  el id detrás de un nombre, típicamente. */
  title?: string
}

const props = withDefaults(
  defineProps<{
    /** `string[]` con `multiple`, `string` sin él. */
    modelValue: string | string[]
    options: ComboOption[]
    /** Varios valores, mostrados como chips. */
    multiple?: boolean
    /** Acepta valores que no están en `options`.
     *
     *  No es un detalle cosmético: con `false`, escribir algo que no existe no
     *  guarda nada, y eso es lo correcto cuando el valor es un id que otro
     *  sistema tiene que resolver (un miembro de Slack: un nombre a mano se ve
     *  bien en la UI y no taguea a nadie). Con `true` el valor escrito se toma
     *  tal cual, que es lo correcto cuando la lista es una sugerencia y no una
     *  autoridad (un tipo de evento que este build todavía no conoce). */
    allowCustom?: boolean
    placeholder?: string
    loading?: boolean
    /** Mensaje de error de la carga de opciones. */
    error?: string
    disabled?: boolean
    /** Qué decir cuando no hay coincidencias. */
    emptyText?: string
    /** `id` del input, para que un `<label for>` de afuera lo enfoque. */
    inputId?: string
    /** Las opciones las filtra QUIEN las provee, no este componente.
     *
     *  El directorio de Slack no cabe en el cliente: `options` es el resultado
     *  de la última búsqueda, no el universo. Filtrar acá encima escondería
     *  resultados que el server ya dijo que coinciden — el caso clásico es
     *  buscar por nombre real y que el server devuelva el handle. */
    remote?: boolean
  }>(),
  {
    multiple: false,
    allowCustom: false,
    loading: false,
    disabled: false,
    emptyText: 'Sin resultados',
    remote: false,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', v: string | string[]): void
  /** Lo que se está escribiendo. Con `remote`, es el pedido de búsqueda. */
  (e: 'search', q: string): void
}>()

const query = ref('')
const open = ref(false)
const activeIndex = ref(-1)
const inputRef = ref<HTMLInputElement | null>(null)

/** Los valores elegidos, siempre como array — el modo simple es el de un solo
 *  elemento, no un camino aparte. */
const selected = computed<string[]>(() => {
  const v = props.modelValue
  if (props.multiple) return Array.isArray(v) ? v : []
  return typeof v === 'string' && v ? [v] : []
})

const optOf = (value: string) => props.options.find((o) => o.value === value)
const labelOf = (value: string) => optOf(value)?.label ?? value
const glyphOf = (value: string) => optOf(value)?.glyph
const titleOf = (value: string) => optOf(value)?.title

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const ya = new Set(props.multiple ? selected.value : [])
  return props.options
    .filter((o) => !ya.has(o.value))
    .filter(
      (o) =>
        props.remote ||
        !q ||
        o.value.toLowerCase().includes(q) ||
        (o.label ?? '').toLowerCase().includes(q) ||
        (o.hint ?? '').toLowerCase().includes(q),
    )
    .slice(0, 50)
})

watch(query, (q) => {
  activeIndex.value = -1
  emit('search', q.trim())
})

/** El valor escrito, cuando no coincide con ninguna opción y se permite. */
const customValue = computed(() => {
  const q = query.value.trim()
  if (!props.allowCustom || !q) return null
  if (props.options.some((o) => o.value === q)) return null
  if (props.multiple && selected.value.includes(q)) return null
  return q
})

function commit(value: string) {
  if (props.multiple) {
    if (selected.value.includes(value)) return
    emit('update:modelValue', [...selected.value, value])
    query.value = ''
  } else {
    emit('update:modelValue', value)
    query.value = ''
    open.value = false
  }
  activeIndex.value = -1
}

function remove(value: string) {
  if (props.multiple) {
    emit('update:modelValue', selected.value.filter((v) => v !== value))
  } else {
    emit('update:modelValue', '')
  }
}

/** Abrir es también un pedido de búsqueda: con `remote`, la lista llega del
 *  server y sin esto el desplegable arrancaría vacío hasta que alguien tipee
 *  algo — justo cuando no sabe qué hay para tipear. */
function onFocus() {
  open.value = true
  emit('search', query.value.trim())
}

/** Salir del campo con algo escrito lo guarda, si el campo acepta valores
 *  propios. Sin esto, escribir un nombre de repo y hacer click en “Guardar”
 *  descartaba lo tipeado: el foco se va antes que el submit y el valor nunca se
 *  llegaba a confirmar. Con `allowCustom: false` no aplica — ahí lo escrito no
 *  es un valor posible. */
function onBlur() {
  open.value = false
  if (customValue.value) commit(customValue.value)
  else query.value = ''
}

async function focusInput() {
  if (props.disabled) return
  open.value = true
  await nextTick()
  inputRef.value?.focus()
}

/** Todo lo elegible ahora, en orden: las opciones y —al final— el valor libre.
 *  Al final y no al principio para que Enter sobre una lista filtrada elija lo
 *  conocido, que es lo que casi siempre se quiere. */
const elegibles = computed<string[]>(() => [
  ...filtered.value.map((o) => o.value),
  ...(customValue.value ? [customValue.value] : []),
])

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    open.value = true
    activeIndex.value = Math.min(activeIndex.value + 1, elegibles.value.length - 1)
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, -1)
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const v = elegibles.value[activeIndex.value] ?? elegibles.value[0]
    if (v) commit(v)
    return
  }
  if (e.key === 'Escape') {
    open.value = false
    return
  }
  // Backspace con el campo vacío borra el último chip: es el gesto esperado en
  // un campo de tags, y evita tener que apuntarle a la ✕ de 12px.
  if (e.key === 'Backspace' && !query.value && props.multiple && selected.value.length) {
    remove(selected.value[selected.value.length - 1])
  }
}
</script>

<template>
  <div class="cb" :class="{ 'cb--disabled': disabled }">
    <div
      class="cb-box"
      :class="{ 'cb-box--open': open }"
      @click="focusInput"
    >
      <!-- Chips: en `multiple` son los valores; en simple, el único elegido.
           Se ven igual en los dos modos a propósito — un valor elegido se lee
           como una ficha, no como texto suelto en un input. -->
      <span v-for="v in selected" :key="v" class="cb-chip" :title="titleOf(v)">
        <span v-if="glyphOf(v)" class="cb-chip__glyph">{{ glyphOf(v) }}</span>
        <span class="cb-chip__text">{{ labelOf(v) }}</span>
        <!-- Un dominio suma su propia acción al chip (copiar un id de Slack)
             sin que este componente sepa de qué dominio es. -->
        <slot name="chip-extra" :value="v" />
        <button
          v-if="!disabled"
          type="button"
          class="cb-chip__x"
          :aria-label="`Quitar ${labelOf(v)}`"
          @click.stop="remove(v)"
        >✕</button>
      </span>

      <input
        :id="inputId"
        ref="inputRef"
        v-model="query"
        class="cb-input"
        :placeholder="selected.length ? '' : placeholder"
        :disabled="disabled"
        autocomplete="off"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
      />
    </div>

    <!-- `mousedown.prevent` y no `click`: el blur del input dispara antes que
         el click y cerraría la lista sin que la elección llegue nunca. -->
    <ul v-if="open && !disabled" class="cb-list" @mousedown.prevent>
      <li v-if="loading" class="cb-note">Buscando…</li>
      <li v-else-if="error" class="cb-note cb-note--error">✕ {{ error }}</li>

      <li
        v-for="(o, i) in filtered"
        :key="o.value"
        :class="['cb-opt', { 'cb-opt--active': i === activeIndex }]"
        @click="commit(o.value)"
        @mouseenter="activeIndex = i"
      >
        <span v-if="o.glyph" class="cb-opt__glyph">{{ o.glyph }}</span>
        <span class="cb-opt__label">{{ o.label ?? o.value }}</span>
        <span v-if="o.hint" class="cb-opt__hint">{{ o.hint }}</span>
      </li>

      <!-- El valor libre, siempre al final y marcado como distinto: que se
           acepte no significa que sea lo mismo que elegir de la lista. -->
      <li
        v-if="customValue"
        :class="['cb-opt', 'cb-opt--custom', { 'cb-opt--active': activeIndex === filtered.length }]"
        @click="commit(customValue)"
        @mouseenter="activeIndex = filtered.length"
      >
        <span class="cb-opt__glyph">+</span>
        <span class="cb-opt__label">usar “{{ customValue }}”</span>
        <span class="cb-opt__hint">valor propio</span>
      </li>

      <!-- Se dice igual con un valor propio a mano: “nada coincide” y “podés
           usarlo igual” son dos cosas distintas, y la primera es la que
           explica POR QUÉ no coincide (un board sin ninguna label todavía). -->
      <li v-if="!loading && !error && !filtered.length" class="cb-note">
        {{ emptyText }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.cb { position: relative; min-width: 0; }
.cb--disabled { opacity: 0.6; }

.cb-box {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.35rem;
  min-height: calc(var(--row-h) + 0.4rem);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  cursor: text;
}
.cb-box--open { border-color: var(--border-hi); }

/* Un chip por valor elegido — la misma caja para todos los tipos, como pide el
   DESIGN_SYSTEM: lo que varía entre ellos es el color del glifo, no la caja. */
.cb-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3ch;
  max-width: 100%;
  padding: 0 0.4ch;
  line-height: var(--row-h);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-alt);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.cb-chip__glyph { color: var(--info); }
.cb-chip__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cb-chip__x {
  border: 0;
  background: none;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0 0 0 0.2ch;
  font-size: var(--fs-micro);
  line-height: 1;
}
.cb-chip__x:hover { color: var(--danger); }

.cb-input {
  flex: 1 1 6ch;
  min-width: 6ch;
  border: 0;
  background: none;
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  line-height: var(--row-h);
  outline: none;
  padding: 0 0.2ch;
}

.cb-list {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 30;
  max-height: 15rem;
  overflow-y: auto;
  margin: 0;
  padding: 0.2rem 0;
  list-style: none;
  background: var(--panel);
  border: 1px solid var(--border-hi);
  border-radius: var(--radius);
}
.cb-opt {
  display: flex;
  align-items: baseline;
  gap: 0.5ch;
  padding: 0 0.6rem;
  line-height: var(--row-h);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.cb-opt--active { background: var(--panel-hi); }
.cb-opt__glyph { color: var(--info); }
.cb-opt__label { color: var(--fg); white-space: nowrap; }
.cb-opt__hint {
  color: var(--fg-dim);
  margin-left: auto;
  padding-left: 0.8ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cb-opt--custom .cb-opt__glyph,
.cb-opt--custom .cb-opt__label { color: var(--accent); }

.cb-note {
  padding: 0.2rem 0.6rem;
  line-height: var(--row-h);
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.cb-note--error { color: var(--danger); }

@media (max-width: 640px) {
  /* La descripción de una opción envuelve en vez de empujar: en 390px un hint
     largo dejaría el nombre sin lugar. */
  .cb-opt { flex-wrap: wrap; line-height: 1.5; padding: 0.25rem 0.6rem; }
  .cb-opt__hint { margin-left: 0; padding-left: 0; flex-basis: 100%; }
}
</style>
