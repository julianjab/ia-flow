<script setup lang="ts">
import type { RuleActionEntry, WhenCondition } from '@ia-flow/shared'
import { computed, ref, watch } from 'vue'
import ActionFields from '@/features/rules/ActionFields.vue'
import ActionWhenEditor from '@/features/rules/ActionWhenEditor.vue'
import {
  actionLabelFor,
  blankActionFor,
  describeAction,
} from '@/features/rules/actionForms/registry'
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue'
import HintIcon from '@/ui/HintIcon.vue'

// v-model sobre el `do[]` de una regla: las acciones que se ejecutan, EN
// ORDEN, cuando la regla matchea. El orden es parte del contrato (una regla
// que primero comenta y después mueve el status tiene que ser predecible), así
// que subir/bajar es una operación de primera clase acá y no un detalle.

const props = defineProps<{
  modelValue: RuleActionEntry[]
  /** Los tipos que el daemon sabe ejecutar (GET /api/rules/action-kinds). Sólo
   *  se ofrecen éstos: una acción que el daemon no tiene fallaría recién en el
   *  primer evento, en silencio. */
  availableKinds: string[]
  agentIds?: string[]
  /** Las acciones con nombre del ámbito, para el campo `ref`. */
  actionIds?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: RuleActionEntry[]): void
}>()

type Entry = Record<string, unknown> & {
  action: string
  continueOnError?: boolean
  id?: string
  when?: WhenCondition[]
}

// Las llaves dobles se arman acá: escritas en el template, el parser de Vue las
// lee como una interpolación suya.
const STEP_REF_EXAMPLE = '{{steps.triage.output.brief}}'

const entries = computed<Entry[]>(() => props.modelValue as unknown as Entry[])

// Colapsadas por default: con 2+ acciones el editor entero es un formulario
// gigante hecho de formularios, y la mayoría de las veces sólo una está por
// tocarse. Cada tarjeta guarda su propio estado de apertura por ÍNDICE — igual
// que el resto de este componente (drag, kind) ya razona por índice — y no por
// una key estable que las acciones no tienen.
const openFlags = ref<boolean[]>(entries.value.map(() => entries.value.length <= 1))

// Resincroniza cuando el `do[]` entero cambia por fuera (otra regla cargada
// en el modal): `entries` es sólo lectura de props, así que un swap externo no
// pasa por `addAction`/`removeAction`, que son los que mantienen `openFlags`
// al día en el camino normal.
watch(
  entries,
  (list) => {
    if (openFlags.value.length !== list.length) {
      openFlags.value = list.map((_, i) => openFlags.value[i] ?? list.length <= 1)
    }
  },
  { immediate: true },
)

function isOpen(i: number): boolean {
  return openFlags.value[i] ?? false
}

function toggleOpen(i: number) {
  const next = [...openFlags.value]
  next[i] = !next[i]
  openFlags.value = next
}

/** Resumen de una línea para la tarjeta colapsada — la MISMA frase que ya lee
 *  `RuleSentence` en el listado, para que abrir o cerrar una tarjeta no
 *  cambie cómo se describe la acción. */
function summaryFor(entry: Entry): string {
  const { text } = describeAction(entry as unknown as RuleActionEntry)
  return text
}

// `ComboBox` y no un `<select>`: el desplegable de un select lo dibuja el
// sistema operativo —fondo blanco y highlight azul sobre una consola oscura— y
// no hay CSS que lo tematice. Es el mismo control que ya usan los campos de
// adentro de la acción. Sin `allow-custom`: un tipo que el daemon no sabe
// ejecutar fallaría recién en el primer evento.
const kindOptions = computed<ComboOption[]>(() =>
  props.availableKinds.map((value) => ({ value, label: actionLabelFor(value), hint: value })),
)

/** Los blancos viven en el registry, al lado del form que los edita: agregar un
 *  tipo de acción es una entrada allá, no un `if` más acá. */
function blankFor(kind: string): Entry {
  return blankActionFor(kind, { agentId: props.agentIds?.[0] }) as Entry
}

function push(next: Entry[]) {
  emit('update:modelValue', next as unknown as RuleActionEntry[])
}

function addAction() {
  const kind = props.availableKinds[0] ?? 'agent'
  push([...entries.value, blankFor(kind)])
  // La recién agregada nace abierta: es la única sin nada que resumir todavía.
  openFlags.value = [...openFlags.value, true]
}

function removeAction(i: number) {
  push(entries.value.filter((_, idx) => idx !== i))
  openFlags.value = openFlags.value.filter((_, idx) => idx !== i)
}

function patch(i: number, changes: Partial<Entry>) {
  push(entries.value.map((e, idx) => (idx === i ? { ...e, ...changes } : e)))
}

/** Cambiar el tipo REEMPLAZA la entrada (ver `blankActionFor`), salvo
 *  `continueOnError` y `when`: viven fuera del union y significan lo mismo en
 *  todos — condicionan CUÁNDO/SI corre el paso, no qué hace. */
function changeKind(i: number, kind: string) {
  const prev = entries.value[i]
  const next = blankFor(kind)
  if (prev?.continueOnError) next.continueOnError = prev.continueOnError
  if (prev?.when) next.when = prev.when
  push(entries.value.map((e, idx) => (idx === i ? next : e)))
}

function move(i: number, delta: number) {
  const target = i + delta
  if (target < 0 || target >= entries.value.length) return
  reorder(i, target)
}

function reorder(from: number, to: number) {
  const next = [...entries.value]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  push(next)

  // El estado de apertura viaja CON la acción, no se queda en la posición —
  // arrastrar una tarjeta abierta al final no debería dejarla cerrada.
  const nextFlags = [...openFlags.value]
  const [movedFlag] = nextFlags.splice(from, 1)
  nextFlags.splice(to, 0, movedFlag)
  openFlags.value = nextFlags
}

// Drag nativo (HTML5), el mismo patrón que el listado de reglas y
// ProviderChoicesEditor: `dataTransfer` lleva el índice de origen y el drop en
// la tarjeta destino reordena. Sin librería y sin un modo "reordenar" aparte.
//
// Lo que arrastra es el ENCABEZADO, no la tarjeta entera: el cuerpo es un
// formulario, y con `draggable` encima el navegador se queda con el gesto de
// seleccionar texto adentro de sus inputs.
const dragIndex = ref<number | null>(null)
const overIndex = ref<number | null>(null)

function onDragStart(i: number, event: DragEvent) {
  dragIndex.value = i
  event.dataTransfer?.setData('text/plain', String(i))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onDragOver(i: number, event: DragEvent) {
  // Sin `preventDefault` el navegador no permite soltar acá.
  event.preventDefault()
  overIndex.value = i
}
function onDragEnd() {
  dragIndex.value = null
  overIndex.value = null
}
function onDrop(to: number) {
  const from = dragIndex.value
  onDragEnd()
  if (from === null || from === to) return
  reorder(from, to)
}

/** El mismo reordenado desde el teclado. El handle es un `button` y no un
 *  `span` justamente para esto: arrastrar no existe sin mouse, y el orden de
 *  las acciones es parte del contrato de la regla. */
function onHandleKey(i: number, event: KeyboardEvent) {
  if (event.key === 'ArrowUp') move(i, -1)
  else if (event.key === 'ArrowDown') move(i, 1)
  else return
  event.preventDefault()
}

</script>

<template>
  <div class="ae">
    <div
      v-for="(entry, i) in entries"
      :key="i"
      class="ae-card"
      :class="{ 'ae-card--over': overIndex === i && dragIndex !== null && dragIndex !== i }"
      @dragover="onDragOver(i, $event)"
      @drop="onDrop(i)"
    >
      <div
        class="ae-head"
        :draggable="entries.length > 1"
        @dragstart="onDragStart(i, $event)"
        @dragend="onDragEnd"
      >
        <button
          v-if="entries.length > 1"
          type="button"
          class="ae-drag"
          aria-label="Reordenar acción (flechas para mover)"
          title="Arrastrar para reordenar"
          @keydown="onHandleKey(i, $event)"
        >⠿</button>
        <button
          type="button"
          class="ae-toggle"
          :aria-expanded="isOpen(i)"
          :aria-label="isOpen(i) ? 'Colapsar acción' : 'Expandir acción'"
          @click="toggleOpen(i)"
        >
          <span class="ae-chevron" :class="{ 'ae-chevron--open': isOpen(i) }" aria-hidden="true">▸</span>
          <span class="ae-idx">{{ i + 1 }}</span>
          <span class="ae-kind-label">{{ actionLabelFor(entry.action) }}</span>
        </button>
        <span v-if="!isOpen(i)" class="ae-summary">{{ summaryFor(entry) }}</span>
        <div class="ae-spacer" />
        <button type="button" class="ae-remove" aria-label="Quitar acción" @click="removeAction(i)">✕</button>
      </div>

      <div v-show="isOpen(i)" class="ae-body">
        <div class="ae-row">
          <span class="ae-label">Tipo</span>
          <ComboBox
            class="ae-kind"
            :model-value="entry.action"
            :options="kindOptions"
            :placeholder="actionLabelFor(entry.action)"
            empty-text="Ningún tipo coincide"
            @update:model-value="(v) => changeKind(i, Array.isArray(v) ? (v[0] ?? '') : v)"
          />
        </div>

        <ActionFields
          :entry="entry"
          :agent-ids="agentIds"
          :action-ids="actionIds"
          @patch="(changes) => patch(i, changes)"
        />

        <label class="ae-row">
          <span class="ae-label">
            Nombre del paso
            <HintIcon
              :text="`Sólo hace falta si una acción posterior lee lo que ésta produjo, con ${STEP_REF_EXAMPLE}. Un nombre y no la posición: un índice se rompe en silencio cuando alguien inserta una acción más arriba.`"
            />
          </span>
          <input
            class="ae-field ae-mono"
            :value="typeof entry.id === 'string' ? entry.id : ''"
            placeholder="triage"
            @input="patch(i, { id: ($event.target as HTMLInputElement).value || undefined })"
          />
        </label>

        <div class="ae-row">
          <span class="ae-label">
            Condición
            <HintIcon
              text="Sólo corre esta acción si además matchea esto — mismo DSL que el `when` de la regla, evaluado también contra lo que dejaron los pasos anteriores (`steps.<paso>.output.<campo>`). Vacío = corre siempre."
            />
          </span>
          <ActionWhenEditor
            :model-value="entry.when"
            @update:model-value="(w) => patch(i, { when: w })"
          />
        </div>

        <label class="ae-check">
          <input
            type="checkbox"
            :checked="entry.continueOnError === true"
            @change="patch(i, { continueOnError: ($event.target as HTMLInputElement).checked })"
          />
          <span>Seguir con las siguientes aunque ésta falle</span>
        </label>
      </div>
    </div>

    <button type="button" class="ae-add" @click="addAction">+ acción</button>
    <p v-if="!entries.length" class="ae-empty">
      Una regla sin acciones no hace nada. Agregá al menos una.
    </p>
  </div>
</template>

<style scoped>
.ae {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.ae-card {
  border: 1px solid var(--border);
  background: var(--panel-alt);
  border-radius: var(--radius-sm);
}
.ae-card--over { border-color: var(--accent); }

.ae-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.4rem;
  background: var(--panel-hi);
  border-bottom: 1px solid var(--border);
}
/* El orden de las acciones es parte de lo que la regla hace, así que se cambia
   arrastrando —igual que en el listado de reglas— y no con un par de flechas
   que hay que apretar N veces para mandar una acción al final. */
.ae-head[draggable='true'] { cursor: grab; }
.ae-head[draggable='true']:active { cursor: grabbing; }

.ae-drag {
  background: none;
  border: none;
  padding: 0;
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  cursor: grab;
  user-select: none;
}
.ae-drag:hover,
.ae-drag:focus-visible { color: var(--fg); }

.ae-idx {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  min-width: 1.2ch;
  text-align: center;
}

/* El botón que colapsa/expande la tarjeta — arranca el header y se lleva el
   índice + el nombre del tipo, que es lo mínimo para reconocer la acción sin
   abrirla. */
.ae-toggle {
  display: flex;
  align-items: center;
  gap: 0.4ch;
  background: none;
  border: none;
  padding: 0;
  height: var(--row-h);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  cursor: pointer;
  flex: 0 0 auto;
  min-width: 0;
}
.ae-toggle:hover .ae-kind-label,
.ae-toggle:focus-visible .ae-kind-label { color: var(--accent); }

.ae-chevron {
  flex-shrink: 0;
  display: inline-block;
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  transition: transform 0.1s;
}
.ae-chevron--open { transform: rotate(90deg); }

.ae-kind-label {
  font-weight: 600;
  white-space: nowrap;
}

/* El resumen sólo aparece colapsada — misma idea que `RuleSentence`, para que
   la fila cerrada siga diciendo qué hace la acción sin obligar a abrirla. */
.ae-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
}

.ae-kind { width: 100%; min-width: 0; }
.ae-spacer { flex: 1 1 auto; }

.ae-body {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.6rem;
}




.ae-field {
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  width: 100%;
  box-sizing: border-box;
  border-radius: var(--radius-sm);
}
.ae-field:focus-visible {
  outline: none;
  border-color: var(--border-hi);
}


.ae-check {
  display: flex;
  align-items: center;
  gap: 0.45ch;
  font-size: var(--fs-body-sm);
  color: var(--fg-mute);
  cursor: pointer;
}

.ae-remove {
  background: none;
  border: none;
  cursor: pointer;
  font-size: var(--fs-micro);
  height: var(--row-h);
  line-height: var(--row-h);
  padding: 0 0.4ch;
  color: var(--danger);
}
.ae-remove:hover { color: var(--fg); background: var(--danger); }

.ae-add {
  align-self: flex-start;
  background: none;
  border: 1px dashed var(--border);
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
  font-family: var(--font-body);
  height: var(--row-h);
  padding: 0 1ch;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.ae-add:hover { border-color: var(--accent); color: var(--accent); }

.ae-empty {
  margin: 0;
  font-size: var(--fs-body-sm);
  color: var(--fg-dimmer);
}

/* Fila del nombre del paso — mismas primitivas que el resto del editor. */
.ae-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ae-label {
  display: inline-flex;
  align-items: center;
  gap: 0.3ch;
  font-size: var(--fs-micro);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.ae-mono {
  font-family: var(--font-mono);
}
</style>
