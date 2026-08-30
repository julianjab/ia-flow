<script setup lang="ts">
import {
  type NamedActionBody,
  type ToolParam,
  TOOL_PARAM_TYPES,
  ToolParamSchema,
  actionReadsPayload,
  extractPayloadFields,
  toolParamsError,
} from '@ia-flow/shared'
import { computed } from 'vue'

// Los parámetros de una tool definida, al lado de la acción que los va a leer.
//
// Lo que hace que esto no sea "un editor de JSON Schema" es la segunda columna
// de información: qué campos interpola la acción. El camino es uno solo —el
// input del modelo viaja como `event.payload` y la acción lo lee con
// `{{event.payload.<campo>}}`— así que los dos lados no son independientes:
//
//   un parámetro que la acción NO lee    el modelo lo completa para nada
//   un campo leído SIN parámetro         se interpola como string vacío, en
//                                        silencio, del lado de la API o el script
//
// Ninguno de los dos es un error que se pueda bloquear —la acción se edita
// aparte y puede cambiar después— así que se muestran, no se prohíben.

const props = defineProps<{
  modelValue: ToolParam[]
  /** El cuerpo de la acción que la tool ejecuta. Ausente ⇒ todavía no se eligió
   *  una, y no hay contra qué contrastar. */
  actionBody?: NamedActionBody | null
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [ToolParam[]] }>()

/** Los campos de primer nivel que la acción interpola. */
const readFields = computed(() =>
  props.actionBody ? extractPayloadFields(props.actionBody) : [],
)

/** `emit` publica su payload tal cual y `agent` sólo mira `payload.item`:
 *  ninguna de las dos va a ver lo que el modelo mande. */
const ignoresInput = computed(
  () => !!props.actionBody && !actionReadsPayload(props.actionBody.action),
)

const declared = computed(() => new Set(props.modelValue.map((p) => p.name)))

/** Leídos por la acción y sin declarar: se ofrecen para agregarlos de un click,
 *  que es la forma más corta de que los dos lados coincidan.
 *
 *  Vacío sobre una acción que no interpola: ofrecer un campo ahí contradiría el
 *  aviso de arriba, que dice que nada de esto le va a llegar. */
const missing = computed(() =>
  ignoresInput.value ? [] : readFields.value.filter((f) => !declared.value.has(f)),
)

/**
 * Los que no se pueden guardar: sin nombre, con un nombre que no es
 * identificador, o repetidos.
 *
 * Se marcan acá y ADEMÁS frenan el guardado en la sección. Un nombre vacío
 * viaja como `properties: { '': ... }` a la API del modelo y le voltea el
 * request entero al run; uno repetido se pisa en silencio al armar el objeto.
 */
const badRows = computed(() => {
  const at = new Map<string, number>()
  const bad = new Set<number>()
  props.modelValue.forEach((p, i) => {
    if (!ToolParamSchema.safeParse(p).success) bad.add(i)
    const previo = at.get(p.name)
    if (previo === undefined) at.set(p.name, i)
    else {
      bad.add(i)
      bad.add(previo)
    }
  })
  return bad
})

const error = computed(() => toolParamsError(props.modelValue))

function isUnread(name: string): boolean {
  return !!props.actionBody && !ignoresInput.value && !readFields.value.includes(name)
}

function replace(next: ToolParam[]) {
  emit('update:modelValue', next)
}

function patch(i: number, partial: Partial<ToolParam>) {
  replace(props.modelValue.map((p, idx) => (idx === i ? { ...p, ...partial } : p)))
}

function remove(i: number) {
  replace(props.modelValue.filter((_, idx) => idx !== i))
}

function add(name = '') {
  replace([...props.modelValue, { name, type: 'string' }])
}
</script>

<template>
  <div class="tp">
    <div class="tp-head">
      <span class="uc-label">Parámetros <span class="tp-count">{{ modelValue.length }}</span></span>
      <button v-if="!disabled" type="button" class="btn btn--ghost" @click="add()">+ parámetro</button>
    </div>

    <p v-if="ignoresInput" class="tp-warn">
      La acción <code>{{ actionBody?.action }}</code> no interpola el input: lo que el modelo
      mande no llega a ningún lado. Los parámetros sólo sirven sobre una acción
      <code>http</code> o <code>script</code>.
    </p>

    <p v-if="!modelValue.length" class="tp-hint">
      Sin parámetros el modelo la invoca sin argumentos. Cada uno viaja como
      <code>event.payload.&lt;nombre&gt;</code>, que es lo que la acción interpola.
    </p>

    <div v-for="(p, i) in modelValue" :key="i" class="tp-row">
      <input
        :value="p.name"
        class="tp-name mono"
        :class="{ 'tp-bad': badRows.has(i) }"
        placeholder="branch"
        :disabled="disabled"
        @input="patch(i, { name: ($event.target as HTMLInputElement).value })"
      />
      <select
        :value="p.type"
        class="tp-type"
        :disabled="disabled"
        @change="patch(i, { type: ($event.target as HTMLSelectElement).value as ToolParam['type'] })"
      >
        <option v-for="t in TOOL_PARAM_TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
      <label class="tp-req">
        <input
          type="checkbox"
          :checked="!!p.required"
          :disabled="disabled"
          @change="patch(i, { required: ($event.target as HTMLInputElement).checked })"
        />
        oblig.
      </label>
      <input
        :value="p.description ?? ''"
        class="tp-desc"
        placeholder="Qué poner acá, para el modelo"
        :disabled="disabled"
        @input="patch(i, { description: ($event.target as HTMLInputElement).value })"
      />
      <button
        v-if="!disabled"
        type="button"
        class="btn btn--ghost tp-x"
        aria-label="Quitar parámetro"
        @click="remove(i)"
      >✕</button>
      <span v-if="isUnread(p.name)" class="tp-unread">la acción no lo lee</span>
    </div>

    <p v-if="error" class="tp-error">✕ {{ error }}</p>

    <p v-if="missing.length" class="tp-missing">
      La acción lee campos que esta tool no declara — el modelo no los va a mandar y quedan
      vacíos:
      <button
        v-for="f in missing"
        :key="f"
        type="button"
        class="btn btn--ghost tp-add"
        :disabled="disabled"
        @click="add(f)"
      >+ {{ f }}</button>
    </p>
  </div>
</template>

<style scoped>
.tp { display: flex; flex-direction: column; gap: 0.25rem; }

/* Los botones son la primitiva global (`.btn`), densificada acá: adentro de una
   fila de campos, la altura de un botón de diálogo parte el renglón. */
.tp .btn {
  height: var(--row-h);
  padding: 0 0.6ch;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.tp input:not([type='checkbox']),
.tp select {
  height: var(--row-h);
  padding: 0 0.5ch;
  min-width: 0;
}
.tp-head { display: flex; align-items: center; gap: 0.5rem; }
.tp-count { color: var(--fg-dim); }
.tp-row { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.tp-name { flex: 0 1 14ch; }
.tp-type { flex: 0 0 11ch; }
.tp-desc { flex: 1 1 20ch; }
.tp-req {
  display: flex;
  align-items: center;
  gap: 0.3ch;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  white-space: nowrap;
}
.tp-x { flex: 0 0 auto; }
.tp-bad { border-color: var(--danger); }
.tp-error { color: var(--danger); }
.tp-hint, .tp-warn, .tp-missing, .tp-unread, .tp-error {
  font-size: var(--fs-micro);
  line-height: 1.5;
  margin: 0;
}
.tp-hint { color: var(--fg-dim); }
.tp-warn, .tp-unread { color: var(--warn); }
.tp-missing { color: var(--fg-dim); display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.tp-unread { flex: 1 1 100%; }
.tp-add { color: var(--accent); border-color: var(--accent); }

@media (max-width: 640px) {
  /* Cada control a su propia línea: en 390px la fila entera queda en cuatro
     campos de 5ch, que es ilegible para lo que se está escribiendo. */
  .tp-name, .tp-type, .tp-desc { flex: 1 1 100%; }
}
</style>
