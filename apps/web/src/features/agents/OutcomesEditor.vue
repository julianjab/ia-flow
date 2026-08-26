<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { MULTI_SELECT_DATA_TYPE, type AgentOutcomes, type CommentTarget } from '@ia-flow/shared'
import LabelOpsEditor from '@/features/agents/LabelOpsEditor.vue'
import { ERROR_EXIT, SUCCESS_EXIT } from '@ia-flow/shared'
import {
  type ExitRowError,
  type FieldAssignment,
  RESERVED_EXITS,
  formToOutcomes,
  validateExits,
  isLabelsField,
  LABELS_FIELD,
  outcomesToForm,
  type OutcomesFormValue,
  type ProjectField,
} from '@/features/agents/outcomes-serialization'

// v-model over the AgentOutcomes subset of AgentDefinition — qué escribe el
// agente de vuelta al issue al arrancar (onProcess) / terminar ok (onFinish)
// / fallar (onError).
//
// Una sola lista por slot: cada fila es "campo : valor". `Labels` es un campo
// más, y su valor son tokens con signo (`+design,-wip`) — no hay una sección
// aparte con filas fijas de Añadir/Quitar/Reemplazar.

const props = defineProps<{
  modelValue: AgentOutcomes
  projectFields?: ProjectField[]
  statusOptions?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: AgentOutcomes): void
}>()

// Las tres opciones, con el texto que explica la regla en el punto donde se
// decide — un select con `issue | pr | pr-else-issue` pelado obliga a saberse
// la semántica de memoria.
const COMMENT_TARGETS: Array<{ value: CommentTarget; label: string }> = [
  { value: 'pr-else-issue', label: 'PR si hay uno abierto, si no el issue' },
  { value: 'pr', label: 'Siempre en el PR (crítica del código)' },
  { value: 'issue', label: 'Siempre en el issue (cambia el alcance)' },
]

const form = ref<OutcomesFormValue>(outcomesToForm(props.modelValue))

// Igual que en WhenConditionsEditor: una fila recién agregada nace vacía y
// `formToOutcomes` la filtra al serializar, así que el padre nos devuelve un
// valor sin ella. Sin recordar lo último emitido, el watcher borraría la fila
// antes de que el usuario llegue a elegir el campo — el botón "+ campo" no
// haría nada visible.
let lastEmitted: string | null = null

watch(
  () => props.modelValue,
  (next) => {
    if (JSON.stringify(next ?? {}) === lastEmitted) return
    form.value = outcomesToForm(next)
  },
)

function emitForm(next: OutcomesFormValue) {
  form.value = next
  const outcomes = formToOutcomes(next)
  lastEmitted = JSON.stringify(outcomes)
  emit('update:modelValue', outcomes)
}

// El catálogo de campos del proyecto ya incluye `Labels` (lo deriva el
// server). Si no hay catálogo, ofrecemos al menos status y labels para que el
// editor siga siendo usable sin fuente.
const fieldNames = computed(() => {
  const names = (props.projectFields ?? []).map((f) => f.name)
  if (!names.length) return ['status', LABELS_FIELD]
  return names.some((n) => isLabelsField(n)) ? names : [...names, LABELS_FIELD]
})

const labelOptions = computed(
  () => props.projectFields?.find((f) => isLabelsField(f.name))?.options ?? [],
)

// Qué fila se edita con tokens con signo: lo decide la DEFINICIÓN del campo
// (`dataType: MULTI_SELECT`, que el source publica en getFields), no su
// nombre. El fallback por nombre cubre el caso sin catálogo — un proyecto
// recién creado, o un source que no implementa getFields — donde igual hay
// que poder editar `Labels`.
const multiValueFields = computed(
  () =>
    new Set(
      (props.projectFields ?? [])
        .filter((f) => f.dataType === MULTI_SELECT_DATA_TYPE)
        .map((f) => f.name.trim().toLowerCase()),
    ),
)

function isMultiValueField(field: string): boolean {
  return multiValueFields.value.has(field.trim().toLowerCase()) || isLabelsField(field)
}

function optionsFor(fieldName: string): string[] {
  if (fieldName.toLowerCase() === 'status') return props.statusOptions ?? []
  return (
    (props.projectFields ?? []).find((f) => f.name.toLowerCase() === fieldName.toLowerCase())
      ?.options ?? []
  )
}

// El editor tiene dos partes distintas y es a propósito:
//  - `onProcess` es un HOOK: corre siempre al arrancar, no hay nada que elegir.
//  - `exits` son DESTINOS: el run termina por uno. `success`/`error` los elige
//    el engine según cómo terminó; los demás los pide el agente por nombre.
const RESERVED_LABEL: Record<string, string> = {
  [SUCCESS_EXIT]: 'Al terminar OK',
  [ERROR_EXIT]: 'Al fallar',
}

function isReserved(name: string): boolean {
  return (RESERVED_EXITS as readonly string[]).includes(name)
}

const selectable = computed(() =>
  form.value.exits.map((e) => e.name.trim()).filter((n) => n && !isReserved(n)),
)

// Un error por fila, para pintar la culpable en vez de un cartel genérico.
const exitProblems = computed(() => validateExits(form.value.exits))

const PROBLEM_TEXT: Record<ExitRowError, string> = {
  duplicada: 'Ya hay otra salida con este nombre — no se guarda.',
  reservada: '`success` y `error` ya están arriba: elegí otro nombre.',
  formato: 'Sólo minúsculas, números y guiones (ej. `back-to-build`).',
  'sin-nombre': 'Ponele un nombre: es lo que el agente usa para pedirla.',
}

function addProcessAssignment() {
  emitForm({ ...form.value, onProcess: [...form.value.onProcess, { field: '', value: '' }] })
}
function removeProcessAssignment(i: number) {
  emitForm({ ...form.value, onProcess: form.value.onProcess.filter((_, idx) => idx !== i) })
}
function updateProcessAssignment(i: number, patch: Partial<{ field: string; value: string }>) {
  emitForm({
    ...form.value,
    onProcess: form.value.onProcess.map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
  })
}

function patchExit(
  ei: number,
  patch: Partial<{
    name: string
    assignments: FieldAssignment[]
    when: string
    comment: CommentTarget | undefined
  }>,
) {
  emitForm({
    ...form.value,
    exits: form.value.exits.map((e, idx) => (idx === ei ? { ...e, ...patch } : e)),
  })
}
function addExit() {
  emitForm({ ...form.value, exits: [...form.value.exits, { name: '', assignments: [], when: '' }] })
}
function removeExit(ei: number) {
  emitForm({ ...form.value, exits: form.value.exits.filter((_, idx) => idx !== ei) })
}
function addAssignment(ei: number) {
  patchExit(ei, { assignments: [...form.value.exits[ei].assignments, { field: '', value: '' }] })
}
function removeAssignment(ei: number, i: number) {
  patchExit(ei, { assignments: form.value.exits[ei].assignments.filter((_, idx) => idx !== i) })
}
function updateAssignment(ei: number, i: number, patch: Partial<{ field: string; value: string }>) {
  patchExit(ei, {
    assignments: form.value.exits[ei].assignments.map((a, idx) =>
      idx === i ? { ...a, ...patch } : a,
    ),
  })
}
</script>

<template>
  <div class="oe">
    <!-- ── Hook de arranque ──────────────────────────────────────────── -->
    <div class="oe-slot">
      <div class="oe-slot-head">
        <span class="uc-label oe-slot-label">Al arrancar</span>
        <button type="button" class="oe-add" @click="addProcessAssignment()">+ campo</button>
      </div>
      <p v-if="!form.onProcess.length" class="oe-empty">Sin cambios al arrancar.</p>
      <div v-for="(a, ai) in form.onProcess" :key="ai" class="oe-assign-row">
        <select
          :value="a.field"
          class="oe-field oe-assign-field"
          @change="updateProcessAssignment(ai, { field: ($event.target as HTMLSelectElement).value, value: '' })"
        >
          <option value="" disabled>— Campo —</option>
          <option v-for="fn in fieldNames" :key="fn" :value="fn">{{ fn }}</option>
        </select>
        <span class="oe-assign-sep">:</span>
        <LabelOpsEditor
          v-if="isMultiValueField(a.field)"
          :model-value="a.value"
          :options="labelOptions"
          @update:model-value="updateProcessAssignment(ai, { value: $event })"
        />
        <select
          v-else-if="optionsFor(a.field).length"
          :value="a.value"
          class="oe-field oe-assign-value"
          @change="updateProcessAssignment(ai, { value: ($event.target as HTMLSelectElement).value })"
        >
          <option value="" disabled>— Valor —</option>
          <option v-for="opt in optionsFor(a.field)" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <input
          v-else
          :value="a.value"
          class="oe-field oe-assign-value"
          placeholder="valor"
          @input="updateProcessAssignment(ai, { value: ($event.target as HTMLInputElement).value })"
        />
        <button type="button" class="oe-remove" aria-label="Quitar campo" @click="removeProcessAssignment(ai)">✕</button>
      </div>
    </div>

    <div class="oe-sep" />

    <!-- ── Salidas ───────────────────────────────────────────────────── -->
    <div class="oe-slot">
      <div class="oe-slot-head">
        <span class="uc-label oe-slot-label">Salidas</span>
        <button type="button" class="oe-add" @click="addExit()">+ salida</button>
      </div>
      <p class="oe-empty">
        El run termina por UNA salida. <code>success</code> y <code>error</code> las elige el
        engine según cómo terminó; cualquier otra la pide el agente por nombre con
        <code>select_exit</code>, y sólo puede nombrar las que estén acá.
      </p>

      <label class="oe-exit-comment oe-agent-comment">
        <span class="oe-exit-hint">Dónde comenta este agente</span>
        <select
          :value="form.comment ?? ''"
          class="oe-field"
          @change="emitForm({ ...form, comment: (($event.target as HTMLSelectElement).value || undefined) as CommentTarget | undefined })"
        >
          <option value="">Por defecto (PR si hay uno abierto, si no el issue)</option>
          <option v-for="t in COMMENT_TARGETS" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
      </label>

      <div v-for="(ex, ei) in form.exits" :key="ei" class="oe-exit">
        <div class="oe-exit-head">
          <template v-if="isReserved(ex.name)">
            <code class="oe-exit-name">{{ ex.name }}</code>
            <span class="oe-exit-hint">{{ RESERVED_LABEL[ex.name] }}</span>
          </template>
          <input
            v-else
            :value="ex.name"
            class="oe-field oe-exit-input"
            :class="{ 'oe-field--bad': exitProblems[ei] }"
            placeholder="nombre-de-la-salida"
            @input="patchExit(ei, { name: ($event.target as HTMLInputElement).value })"
          />
          <button type="button" class="oe-add" @click="addAssignment(ei)">+ campo</button>
          <button
            v-if="!isReserved(ex.name)"
            type="button"
            class="oe-remove"
            aria-label="Quitar salida"
            @click="removeExit(ei)"
          >✕</button>
        </div>

        <p v-if="exitProblems[ei]" class="oe-bad">{{ PROBLEM_TEXT[exitProblems[ei]!] }}</p>

        <!-- El `when` va al enum de select_exit: es lo que el modelo lee para
             decidir. Las reservadas no lo llevan — el agente nunca las pide. -->
        <input
          v-if="!isReserved(ex.name)"
          :value="ex.when ?? ''"
          class="oe-field oe-exit-when"
          placeholder="Cuándo usarla — lo lee el agente para decidir"
          @input="patchExit(ei, { when: ($event.target as HTMLInputElement).value })"
        />

        <!-- A diferencia del `when`, las reservadas SÍ lo llevan: success y
             error son dos hallazgos distintos y pueden pertenecer a lugares
             distintos (el bug técnico al PR, el cambio de alcance al issue). -->
        <label class="oe-exit-comment">
          <span class="oe-exit-hint">Comentario</span>
          <select
            :value="ex.comment ?? ''"
            class="oe-field"
            @change="patchExit(ei, { comment: (($event.target as HTMLSelectElement).value || undefined) as CommentTarget | undefined })"
          >
            <option value="">Igual que el agente</option>
            <option v-for="t in COMMENT_TARGETS" :key="t.value" :value="t.value">{{ t.label }}</option>
          </select>
        </label>

        <p v-if="!ex.assignments.length" class="oe-empty">Sin cambios en esta salida.</p>

        <div v-for="(a, ai) in ex.assignments" :key="ai" class="oe-assign-row">
          <select
            :value="a.field"
            class="oe-field oe-assign-field"
            @change="updateAssignment(ei, ai, { field: ($event.target as HTMLSelectElement).value, value: '' })"
          >
            <option value="" disabled>— Campo —</option>
            <option v-for="fn in fieldNames" :key="fn" :value="fn">{{ fn }}</option>
          </select>
          <span class="oe-assign-sep">:</span>
          <LabelOpsEditor
            v-if="isMultiValueField(a.field)"
            :model-value="a.value"
            :options="labelOptions"
            @update:model-value="updateAssignment(ei, ai, { value: $event })"
          />
          <select
            v-else-if="optionsFor(a.field).length"
            :value="a.value"
            class="oe-field oe-assign-value"
            @change="updateAssignment(ei, ai, { value: ($event.target as HTMLSelectElement).value })"
          >
            <option value="" disabled>— Valor —</option>
            <option v-for="opt in optionsFor(a.field)" :key="opt" :value="opt">{{ opt }}</option>
          </select>
          <input
            v-else
            :value="a.value"
            class="oe-field oe-assign-value"
            placeholder="valor"
            @input="updateAssignment(ei, ai, { value: ($event.target as HTMLInputElement).value })"
          />
          <button type="button" class="oe-remove" aria-label="Quitar campo" @click="removeAssignment(ei, ai)">✕</button>
        </div>
      </div>

      <p v-if="selectable.length" class="oe-empty">
        El agente puede pedir: <code>{{ selectable.join('</code>, <code>') }}</code>. Sin un
        "cuándo usarla", sólo ve el nombre — y tenés que explicarlo vos en el prompt.
      </p>
    </div>
  </div>
</template>

<style scoped>
.oe {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.oe-sep {
  border-top: 1px dashed var(--border-mute);
}
.oe-slot {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding-top: 0.4rem;
}
.oe-slot-label { color: var(--fg-mute); }
.oe-exit {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.3rem 0 0.3rem 0.6ch;
  border-left: 2px solid var(--border);
}
.oe-exit-head {
  display: flex;
  align-items: center;
  gap: 0.6ch;
}
.oe-exit-name {
  font-family: var(--font-mono);
  color: var(--fg);
}
.oe-exit-hint { color: var(--fg-mute); }
.oe-exit-input { flex: 0 1 22ch; }
.oe-exit-comment {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.oe-agent-comment {
  margin-bottom: 8px;
}
.oe-exit-when {
  width: 100%;
  font-size: var(--fs-body-sm);
}
.oe-field--bad {
  border-color: var(--red);
}
.oe-bad {
  margin: 0;
  font-size: var(--fs-body-sm);
  color: var(--red);
}
.oe-slot-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.oe-empty {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
}

.oe-assign-row { display: flex; align-items: center; gap: 0.3rem; }
.oe-field {
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
}
.oe-assign-field { flex: 1 1 0; min-width: 0; }
.oe-assign-sep { color: var(--fg-dim); flex-shrink: 0; }
.oe-assign-value { flex: 1 1 0; min-width: 0; }

.oe-add {
  background: none;
  border: 1px dashed var(--border);
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  font-family: var(--font-mono);
  height: var(--row-h);
  padding: 0 1ch;
  cursor: pointer;
  white-space: nowrap;
}
.oe-add:hover { border-color: var(--accent); color: var(--accent); }

.oe-remove {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--danger);
  cursor: pointer;
  font-size: var(--fs-micro);
  padding: 0 0.3ch;
  line-height: var(--row-h);
}
.oe-remove:hover { color: var(--fg); background: var(--danger); }

</style>
