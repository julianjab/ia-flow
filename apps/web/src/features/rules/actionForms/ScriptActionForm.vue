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
  <div class="af-row af-row-split">
    <label class="af-sub af-sub-narrow">
      <span class="af-lbl">Runtime</span>
      <select
        class="af-field"
        :value="str('runtime') || 'bash'"
        @change="emit('patch', { runtime: ($event.target as HTMLSelectElement).value })"
      >
        <option v-for="r in RUNTIMES" :key="r" :value="r">{{ r }}</option>
      </select>
    </label>
    <label class="af-sub">
      <span class="af-lbl">Archivo</span>
      <input
        class="af-field af-mono"
        :value="str('file')"
        placeholder="scripts/avisar-deploy.sh"
        @input="emit('patch', { file: ($event.target as HTMLInputElement).value })"
      />
    </label>
  </div>
  <p v-if="str('file').startsWith('/')" class="af-error">
    La ruta es relativa al repo de la tarea, no absoluta.
  </p>

  <div class="af-row">
    <span class="af-lbl">Argumentos</span>
    <div class="af-list">
      <div v-for="(arg, i) in args()" :key="i" class="af-list-row">
        <input
          class="af-field af-mono af-list-val"
          :value="arg"
          placeholder="{{event.payload.pr.number}}"
          @input="setArg(i, ($event.target as HTMLInputElement).value)"
        />
        <button
          type="button"
          class="af-drop"
          aria-label="Quitar argumento"
          @click="setArgs(args().filter((_, idx) => idx !== i))"
        >✕</button>
      </div>
      <button type="button" class="af-add" @click="setArgs([...args(), ''])">+ argumento</button>
    </div>
    <span class="af-hint">
      Van como argv, nunca por una shell: un valor con espacios o <code>;</code> es un
      argumento y no un comando.
    </span>
  </div>

  <div class="af-row">
    <span class="af-lbl">Variables de entorno</span>
    <KeyValueRows
      :model-value="env()"
      key-placeholder="PR_URL"
      value-placeholder="{{event.payload.pr.url}}"
      add-label="+ variable"
      @update:model-value="(v) => emit('patch', { env: Object.keys(v).length ? v : undefined })"
    />
    <span class="af-hint">
      El script recibe SÓLO éstas. No hereda el entorno del daemon — ni su
      <code>GITHUB_TOKEN</code> ni su <code>ANTHROPIC_API_KEY</code>.
    </span>
  </div>

  <label class="af-row af-narrow">
    <span class="af-lbl">Timeout (ms)</span>
    <input
      class="af-field af-mono"
      type="number"
      min="1"
      :value="typeof entry.timeoutMs === 'number' ? entry.timeoutMs : ''"
      placeholder="60000"
      @input="setTimeoutMs(($event.target as HTMLInputElement).value)"
    />
  </label>

  <p class="af-hint">
    Corre en el repo de la tarea del evento, y sólo en esta máquina — nunca viaja a un
    agent-host remoto. La capacidad viene apagada: el daemon necesita
    <code>IA_FLOW_ENABLE_SCRIPT_ACTIONS=1</code> y un <code>IA_FLOW_API_TOKEN</code> puesto,
    o la acción falla con ese motivo.
  </p>
</template>

<style scoped src="./fields.css"></style>
