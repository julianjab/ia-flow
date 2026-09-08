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
//
// **No lo envuelvas en un `<label>`.** Un `<label>` reenvía el click de
// cualquier descendiente a su PRIMER control, y con chips ése es la ✕ del
// primer chip: elegir del desplegable agregaba el valor y acto seguido borraba
// el que ya estaba. Etiquetalo con un `<span>` al lado, o con
// `<label :for>` + `inputId`.

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

// Con un solo valor el input MUESTRA el valor, así que `query` arranca en él y
// hay que distinguir "no tocó nada" de "escribió justo lo mismo": sin `touched`,
// abrir un campo ya elegido filtraría la lista por su propio valor y dejaría una
// sola opción — la que ya está puesta.
const query = ref('')
const touched = ref(false)
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

/** Lo que se está buscando. Con un solo valor, sólo cuenta desde que se
 *  escribió algo: el texto que ya estaba es el valor, no una búsqueda. */
const search = computed(() =>
  props.multiple || touched.value ? query.value.trim() : '',
)

const filtered = computed(() => {
  const q = search.value.toLowerCase()
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

// `sync` para que el orden sea determinista: quien setea `query` a mano (elegir
// una opción, salir del campo) apaga `touched` en la línea siguiente, y con el
// flush diferido de Vue ese apagado corría ANTES que el watcher y se perdía.
watch(
  query,
  () => {
    activeIndex.value = -1
    touched.value = true
    emit('search', query.value.trim())
  },
  { flush: 'sync' },
)

// Un cambio de afuera (otra tarjeta, un reset del form) se refleja en el texto.
//
// Se mira el LABEL y no el `modelValue` porque el label puede llegar después:
// `SlackChannelField` guarda un id (`C0AG…`) y su nombre lo resuelve un fetch
// que termina más tarde. Pero por eso mismo hay que respetar `touched`: sin ese
// gate, ese fetch llegando mientras alguien tipea le borraba el texto y le
// dejaba el `#nombre` del valor viejo.
watch(
  () => (props.multiple ? '' : labelOf(selected.value[0] ?? '')),
  (label) => {
    if (props.multiple || touched.value) return
    query.value = selected.value.length ? label : ''
    // Escribir acá no es "el usuario tipeó": el watcher sync de `query` acaba
    // de prender `touched`, y dejarlo prendido congelaría el texto para
    // siempre — ninguna actualización posterior de afuera volvería a entrar.
    touched.value = false
  },
  { immediate: true },
)

/** El valor escrito, cuando no coincide con ninguna opción y se permite. */
const customValue = computed(() => {
  const q = search.value
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
    // El texto elegido queda a la vista: es el valor, no un residuo de búsqueda.
    query.value = labelOf(value)
    touched.value = false
    open.value = false
  }
  activeIndex.value = -1
}

function remove(value: string) {
  if (props.multiple) {
    emit('update:modelValue', selected.value.filter((v) => v !== value))
  } else {
    emit('update:modelValue', '')
    query.value = ''
    touched.value = false
  }
}

/** Abrir es también un pedido de búsqueda: con `remote`, la lista llega del
 *  server y sin esto el desplegable arrancaría vacío hasta que alguien tipee
 *  algo — justo cuando no sabe qué hay para tipear. */
function onFocus() {
  open.value = true
  // Se emite el TEXTO, no `search`: el que provee las opciones quiere saber qué
  // dice el campo. `touched` es asunto interno —de qué filtrar acá— y apagarlo
  // no debería borrarle al padre el contexto que ya tenía cargado.
  emit('search', query.value.trim())
  touched.value = false
}

/** La opción cuyo texto es exactamente lo escrito. Se compara contra el label y
 *  no sólo contra el value porque el campo MUESTRA el label: quien tipea
 *  `#reviews` está nombrando el canal `C0AG…`. */
function exactMatch(q: string): ComboOption | undefined {
  return props.options.find((o) => o.value === q || (o.label ?? o.value) === q)
}

/**
 * Salir del campo confirma lo escrito.
 *
 * Sin esto, escribir un repo y hacer click en “Guardar” descartaba lo tipeado:
 * el foco se va antes que el submit y el valor nunca llegaba a confirmarse.
 *
 * Las dos ramas hacen falta, y quedarse sólo con `customValue` era el bug más
 * fino: un texto que coincide EXACTO con una opción no es un valor propio, así
 * que `customValue` da `null` y el campo revertía al valor viejo en silencio —
 * fallando justamente para los valores que la lista conoce, que son los que uno
 * espera que anden.
 */
function onBlur() {
  open.value = false
  const escrito = search.value

  const exacta = escrito ? exactMatch(escrito) : undefined
  if (exacta) {
    commit(exacta.value)
    return
  }
  if (customValue.value) {
    commit(customValue.value)
    return
  }

  // Nada que confirmar: el multi limpia la búsqueda, el simple vuelve a mostrar
  // su valor —o queda vacío si lo que se escribió no era elegible.
  query.value = props.multiple ? '' : labelOf(selected.value[0] ?? '')
  touched.value = false
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
      <!-- Los chips son el lenguaje del multi: dicen "hay varios y éste es uno
           de ellos". Con un solo valor no hay nada que enumerar, y una ficha
           encerrando el único contenido del campo se lee como un elemento de
           una lista de uno. Ahí el valor ES el texto del input. -->
      <span
        v-for="v in multiple ? selected : []"
        :key="v"
        class="cb-chip"
        :title="titleOf(v)"
      >
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

      <span v-if="!multiple && selected.length && glyphOf(selected[0])" class="cb-glyph">
        {{ glyphOf(selected[0]) }}
      </span>

      <input
        :id="inputId"
        ref="inputRef"
        v-model="query"
        class="cb-input"
        :placeholder="multiple && selected.length ? '' : placeholder"
        :title="multiple ? undefined : titleOf(selected[0] ?? '')"
        :disabled="disabled"
        autocomplete="off"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
      />

      <!-- Con un solo valor, lo que el dominio agrega y la ✕ van al lado del
           texto: es el mismo lugar que ocupaban dentro del chip. -->
      <template v-if="!multiple && selected.length">
        <slot name="chip-extra" :value="selected[0]" />
        <button
          v-if="!disabled"
          type="button"
          class="cb-clear"
          :aria-label="`Quitar ${labelOf(selected[0])}`"
          @click.stop="remove(selected[0])"
        >✕</button>
      </template>
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

.cb-glyph {
  color: var(--info);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  line-height: var(--row-h);
}
.cb-clear {
  border: 0;
  background: none;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0 0.2ch;
  font-size: var(--fs-micro);
  line-height: var(--row-h);
}
.cb-clear:hover { color: var(--danger); }

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
/* La fila recorta, no empuja: un nombre o una descripción largos hacían crecer
   el `<li>` más allá del desplegable y el texto se salía por el costado. Con el
   clip acá y `min-width: 0` en las dos partes, cada una cede lo suyo y el corte
   sale con puntos suspensivos. */
.cb-opt {
  display: flex;
  align-items: baseline;
  gap: 0.5ch;
  padding: 0 0.6rem;
  line-height: var(--row-h);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  overflow: hidden;
}
.cb-opt--active { background: var(--panel-hi); }
.cb-opt__glyph { color: var(--info); flex: none; }
/* El nombre cede último: es lo que identifica la opción. */
.cb-opt__label {
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 0 1 auto;
  min-width: 0;
}
.cb-opt__hint {
  color: var(--fg-dim);
  margin-left: auto;
  padding-left: 0.8ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
  text-align: right;
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
  .cb-opt__hint { margin-left: 0; padding-left: 0; flex-basis: 100%; text-align: left; }
}
</style>
