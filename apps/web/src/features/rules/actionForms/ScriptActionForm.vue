<script setup lang="ts">
import type { ActionFormEmits, ActionFormProps } from '@/features/rules/actionForms/types'
import KeyValueRows from '@/features/rules/actionForms/KeyValueRows.vue'

// `script` — correr un archivo del repo de la tarea.
//
// **No hay campo de código, a propósito**: el script vive en el repo, así que
// pasa por review y queda versionado. Ver `packages/shared/src/script-action.ts`.
// Este form edita las coordenadas de ESE archivo, no su contenido.

const props = defineProps<ActionFormProps>()
const emit = defineEmits<ActionFormEmits>()

/** Cerrado porque `runtime` elige el binario que se spawnea: dejarlo abierto
 *  sería dejar elegir qué se ejecuta. Espejo de `ScriptRuntimeSchema`. */
const RUNTIMES = ['bash', 'python']

const str = (key: string) => (typeof props.entry[key] === 'string' ? (props.entry[key] as string) : '')

const args = () => (Array.isArray(props.entry.args) ? (props.entry.args as string[]) : [])
const env = () => (props.entry.env ?? {}) as Record<string, string>

function setArgs(next: string[]) {
  emit('patch', { args: next.length ? next : undefined })
}

function setArg(i: number, value: string) {
  setArgs(args().map((a, idx) => (idx === i ? value : a)))
}

function setTimeoutMs(raw: string) {
  const n = Number.parseInt(raw, 10)
  emit('patch', { timeoutMs: Number.isFinite(n) && n > 0 ? n : undefined })
}
</script>

<template>
  <div class="ff-row ff-row-split">
    <label class="ff-sub ff-sub-narrow">
      <span class="uc-label">Runtime</span>
      <select
        class="ff-field"
        :value="str('runtime') || 'bash'"
        @change="emit('patch', { runtime: ($event.target as HTMLSelectElement).value })"
      >
        <option v-for="r in RUNTIMES" :key="r" :value="r">{{ r }}</option>
      </select>
    </label>
    <label class="ff-sub">
      <span class="uc-label">Archivo</span>
      <input
        class="ff-field ff-mono"
        :value="str('file')"
        placeholder="scripts/avisar-deploy.sh"
        @input="emit('patch', { file: ($event.target as HTMLInputElement).value })"
      />
    </label>
  </div>
  <p v-if="str('file').startsWith('/')" class="ff-error">
    La ruta es relativa al repo de la tarea, no absoluta.
  </p>

  <div class="ff-row">
    <span class="uc-label">Argumentos</span>
    <div class="ff-list">
      <div v-for="(arg, i) in args()" :key="i" class="ff-list-row">
        <input
          class="ff-field ff-mono ff-list-val"
          :value="arg"
          placeholder="{{event.payload.pr.number}}"
          @input="setArg(i, ($event.target as HTMLInputElement).value)"
        />
        <button
          type="button"
          class="ff-drop"
          aria-label="Quitar argumento"
          @click="setArgs(args().filter((_, idx) => idx !== i))"
        >✕</button>
      </div>
      <button type="button" class="ff-add" @click="setArgs([...args(), ''])">+ argumento</button>
    </div>
    <span class="ff-hint">
      Van como argv, nunca por una shell: un valor con espacios o <code>;</code> es un
      argumento y no un comando.
    </span>
  </div>

  <div class="ff-row">
    <span class="uc-label">Variables de entorno</span>
    <KeyValueRows
      :model-value="env()"
      key-placeholder="PR_URL"
      value-placeholder="{{event.payload.pr.url}}"
      add-label="+ variable"
      @update:model-value="(v) => emit('patch', { env: Object.keys(v).length ? v : undefined })"
    />
    <span class="ff-hint">
      El script recibe SÓLO éstas. No hereda el entorno del daemon — ni su
      <code>GITHUB_TOKEN</code> ni su <code>ANTHROPIC_API_KEY</code>.
    </span>
  </div>

  <label class="ff-row ff-narrow">
    <span class="uc-label">Timeout (ms)</span>
    <input
      class="ff-field ff-mono"
      type="number"
      min="1"
      :value="typeof entry.timeoutMs === 'number' ? entry.timeoutMs : ''"
      placeholder="60000"
      @input="setTimeoutMs(($event.target as HTMLInputElement).value)"
    />
  </label>

  <p class="ff-hint">
    Corre en el repo de la tarea del evento, y sólo en esta máquina — nunca viaja a un
    agent-host remoto. La capacidad viene apagada: el daemon necesita
    <code>IA_FLOW_ENABLE_SCRIPT_ACTIONS=1</code> y un <code>IA_FLOW_API_TOKEN</code> puesto,
    o la acción falla con ese motivo.
  </p>
</template>

<style scoped src="@/ui/form-fields.css"></style>
