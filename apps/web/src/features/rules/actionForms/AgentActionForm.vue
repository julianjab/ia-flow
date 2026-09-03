<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ActionFormEmits, ActionFormProps } from '@/features/rules/actionForms/types'
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue'
import HintIcon from '@/ui/HintIcon.vue'

// `agent` — correr un agente cuando la regla matchea.

const props = defineProps<ActionFormProps>()
const emit = defineEmits<ActionFormEmits>()

const str = (key: string) => (typeof props.entry[key] === 'string' ? (props.entry[key] as string) : '')

// Las llaves dobles del ejemplo se arman acá y no en el template: escritas
// literalmente, el parser de Vue las lee como una interpolación suya.
const VAR_TYPE = '{{event.type}}'
const VAR_PR = '{{event.payload.pr.number}}'
const BRIEF_PLACEHOLDER = `Llegó feedback nuevo sobre el PR #${VAR_PR} — atendé ese pedido, no re-implementes.`

const options = (): ComboOption[] => (props.agentIds ?? []).map((value) => ({ value }))
const one = (v: string | string[]) => (Array.isArray(v) ? (v[0] ?? '') : v)
const many = (v: string | string[]) => {
  const list = Array.isArray(v) ? v : [v]
  const clean = list.filter(Boolean)
  // Lista vacía ⇒ `undefined`: un `[]` guardado dice "declaré los destinos" y
  // no declara ninguno, y el gate lo rechaza igual — mejor no escribirlo.
  return clean.length ? clean : undefined
}

/** El `agentId` sale de un paso anterior, así que lo elige un modelo y la
 *  lista de destinos deja de ser opcional (el CRUD rechaza la regla sin ella).
 *  El campo aparece sólo entonces: para un id literal sería ruido. */
const dynamicAgentId = computed(() => str('agentId').includes('{{steps.'))
const allowAgents = (): string[] =>
  Array.isArray(props.entry.allowAgents) ? (props.entry.allowAgents as string[]) : []

/** `emitOn` es un enum de un solo valor (`'exit'`), así que se edita como un
 *  check: un desplegable con una opción es una decisión disfrazada de menú. */
function toggleEmit(on: boolean) {
  emit('patch', on ? { emitOn: 'exit' } : { emitOn: undefined, emitType: undefined })
}

// ── Redirección de salidas ─────────────────────────────────────────────────
//
// Filas nombre→destino y no un textarea de JSON: la regla redirige el DESTINO
// de una salida que el agente ya declara, y ése es siempre la forma corta (el
// nombre de un status, o un `$set:`). Un editor de JSON invitaría a escribir
// la forma larga —`when`, `comment`— que es del agente, no de la regla.
type ExitRow = { name: string; dest: string }

/**
 * Las filas son estado LOCAL, no una vista derivada de `entry.exits`.
 *
 * Tienen que serlo: una fila a medio escribir —recién agregada, o con el
 * nombre borrado mientras se edita— no se puede guardar (ver `emitExits`), y
 * si la única fuente fuera el patch, esa fila desaparecería del DOM apenas se
 * escribe. Con `exits` derivado de props el botón "+ salida" no llegaba
 * siquiera a renderizar una fila vacía.
 *
 * Se siembra una vez: el modal monta un form por acción, así que no hay
 * ediciones externas de `entry.exits` que reconciliar.
 */
const rows = ref<ExitRow[]>(
  Object.entries((props.entry.exits ?? {}) as Record<string, unknown>).map(([name, v]) => ({
    name,
    dest: typeof v === 'string' ? v : ((v as { set?: string })?.set ?? ''),
  })),
)

/**
 * Sube sólo las filas COMPLETAS.
 *
 * El destino vacío se descarta igual que el nombre vacío, y no es simetría
 * cosmética: `resolveEffectiveExits` acepta cualquier clave que el agente
 * declare, así que un `{ success: '' }` pisaría el destino real del agente con
 * un status vacío. Una fila a medio escribir no puede cambiar el
 * comportamiento del run.
 *
 * Sin ninguna completa se manda `undefined` y no `{}`: un record vacío es una
 * regla que dice "redirijo salidas" y no redirige ninguna.
 */
function emitExits() {
  const out: Record<string, string> = {}
  for (const { name, dest } of rows.value) {
    if (name.trim() && dest.trim()) out[name.trim()] = dest.trim()
  }
  emit('patch', { exits: Object.keys(out).length ? out : undefined })
}

function addExit() {
  rows.value.push({ name: '', dest: '' })
}

function removeExit(i: number) {
  rows.value.splice(i, 1)
  emitExits()
}
</script>

<template>
  <!-- `div` y no `label`: un `<label>` reenvía el click de cualquier
       descendiente a su PRIMER control, y en un ComboBox con chips ése es la
       ✕ del primer chip. Ver el comentario en `ui/ComboBox.vue`. -->
  <div class="ff-row">
    <span class="uc-label">Agente</span>
    <ComboBox
      allow-custom
      class="ff-combo"
      :model-value="str('agentId')"
      :options="options()"
      placeholder="id del agente"
      empty-text="Ninguno conocido coincide — se guarda igual"
      @update:model-value="(v) => emit('patch', { agentId: one(v) })"
    />
  </div>

  <label v-if="dynamicAgentId" class="ff-row">
    <span class="uc-label">
      Destinos permitidos
      <HintIcon
        text="El agentId sale de un paso anterior, así que lo elige un modelo. Declará acá entre qué agentes puede elegir: el operador declara el espacio, el modelo elige adentro. Sin la lista, la regla no se guarda."
      />
    </span>
    <ComboBox
      allow-custom
      multiple
      class="ff-combo"
      :model-value="allowAgents()"
      :options="options()"
      placeholder="implementer, reviewer"
      empty-text="Ninguno conocido coincide — se guarda igual"
      @update:model-value="(v) => emit('patch', { allowAgents: many(v) })"
    />
  </label>

  <label class="ff-row">
    <span class="uc-label">
      Por qué corre
      <HintIcon
        :text="`Se antepone al prompt del agente. Es lo único que la regla sabe y el agente no: qué lo despertó. Admite ${VAR_TYPE} y cualquier camino del payload (${VAR_PR}).`"
      />
    </span>
    <textarea
      class="ff-field ff-textarea"
      rows="3"
      :value="str('brief')"
      :placeholder="BRIEF_PLACEHOLDER"
      @input="emit('patch', { brief: ($event.target as HTMLTextAreaElement).value || undefined })"
    ></textarea>
  </label>

  <div class="ff-row">
    <span class="uc-label">
      Redirigir salidas
      <HintIcon
        text="Cambia a dónde va una salida que el agente YA declara — sirve para correr el mismo roster contra otro board sin clonar los agentes. Una salida que el agente no declara se ignora: la regla elige el destino, no inventa salidas."
      />
    </span>
    <div v-for="(row, i) in rows" :key="i" class="aaf-exit">
      <input
        v-model="row.name"
        class="ff-field ff-mono aaf-exit__name"
        placeholder="success"
        @input="emitExits()"
      />
      <span class="aaf-exit__arrow">→</span>
      <input
        v-model="row.dest"
        class="ff-field ff-mono"
        placeholder="QA Interna"
        @input="emitExits()"
      />
      <button type="button" class="aaf-exit__del" title="Quitar" @click="removeExit(i)">✕</button>
    </div>
    <button type="button" class="aaf-exit__add" @click="addExit()">+ salida</button>
  </div>

  <label class="ff-check">
    <input
      type="checkbox"
      :checked="entry.emitOn === 'exit'"
      @change="toggleEmit(($event.target as HTMLInputElement).checked)"
    />
    <span>Publicar el resultado del run como evento</span>
  </label>

  <label class="ff-check">
    <input
      type="checkbox"
      :checked="entry.liveInject === true"
      @change="
        emit('patch', {
          liveInject: ($event.target as HTMLInputElement).checked || undefined,
        })
      "
    />
    <span>
      Si la task ya tiene un run en vuelo, inyectar el brief ahí en vez de diferir
      <HintIcon
        text="Sólo aplica cuando el run en vuelo corre sobre anthropic-api (el único provider que lee mensajes nuevos en vivo). Sin esto, un choque con el lock de la task se difiere y se pierde salvo que algo más dispare un run nuevo — útil para un paso de triage que sólo existe para elegir destino: si la task YA tiene cualquier agente corriendo, mejor avisarle directo que esperar a poder decidir."
      />
    </span>
  </label>

  <label v-if="entry.emitOn === 'exit'" class="ff-row">
    <span class="uc-label">
      Tipo del evento
      <HintIcon
        text="Vacío ⇒ run.finished. Es lo que convierte a un agente en normalizador: su salida entra al bus como un evento que otras reglas pueden ver."
      />
    </span>
    <input
      class="ff-field ff-mono"
      :value="str('emitType')"
      placeholder="run.finished"
      @input="emit('patch', { emitType: ($event.target as HTMLInputElement).value || undefined })"
    />
  </label>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
/* Fila nombre → destino. Alto de fila del sistema (22px), sin radios ni
   colores propios: todo sale de theme.css. */
.aaf-exit {
  display: flex;
  align-items: center;
  gap: 0.5ch;
  margin-bottom: 2px;
}
.aaf-exit__name {
  flex: 0 0 14ch;
}
.aaf-exit__arrow {
  color: var(--fg-dim);
  flex: 0 0 auto;
}
.aaf-exit__del,
.aaf-exit__add {
  background: none;
  border: none;
  color: var(--fg-dim);
  cursor: pointer;
  font: inherit;
  height: var(--row-h);
  padding: 0 0.5ch;
}
.aaf-exit__del:hover,
.aaf-exit__add:hover {
  color: var(--fg);
}
.aaf-exit__add {
  align-self: flex-start;
}
</style>
