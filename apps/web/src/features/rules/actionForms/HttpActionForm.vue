<script setup lang="ts">
import type { ActionFormEmits, ActionFormProps } from '@/features/rules/actionForms/types'
import KeyValueRows from '@/features/rules/actionForms/KeyValueRows.vue'
import HintIcon from '@/ui/HintIcon.vue'

// `http` — llamar a una API cuando la regla matchea.

const props = defineProps<ActionFormProps>()
const emit = defineEmits<ActionFormEmits>()

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const str = (key: string) => (typeof props.entry[key] === 'string' ? (props.entry[key] as string) : '')

/** El body se edita como texto porque puede ser cualquier JSON, y se guarda
 *  como string si no parsea — así un JSON a medio escribir no se pierde al
 *  cerrar el modal. */
function bodyText(): string {
  const v = props.entry.body
  if (v === undefined) return ''
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
}

function setBody(raw: string) {
  if (!raw.trim()) {
    emit('patch', { body: undefined })
    return
  }
  try {
    emit('patch', { body: JSON.parse(raw) })
  } catch {
    emit('patch', { body: raw })
  }
}

const headers = () => (props.entry.headers ?? {}) as Record<string, string>

/** Un timeout vacío no es cero: es "usá el default del daemon". Mandar `0`
 *  sería un timeout imposible de cumplir y el schema lo rechaza. */
function setTimeoutMs(raw: string) {
  const n = Number.parseInt(raw, 10)
  emit('patch', { timeoutMs: Number.isFinite(n) && n > 0 ? n : undefined })
}
</script>

<template>
  <div class="ff-row ff-row-split">
    <label class="ff-sub ff-sub-narrow">
      <span class="uc-label">Método</span>
      <select
        class="ff-field"
        :value="str('method') || 'POST'"
        @change="emit('patch', { method: ($event.target as HTMLSelectElement).value })"
      >
        <option v-for="m in METHODS" :key="m" :value="m">{{ m }}</option>
      </select>
    </label>
    <label class="ff-sub">
      <span class="uc-label">URL</span>
      <input
        class="ff-field ff-mono"
        :value="str('url')"
        placeholder="https://hooks.internal/deploy"
        @input="emit('patch', { url: ($event.target as HTMLInputElement).value })"
      />
    </label>
  </div>

  <div class="ff-row">
    <span class="uc-label">
      Headers
      <HintIcon
        :text="'{{event.payload...}} se reemplaza por el valor del evento. ${SECRETO} lo resuelve el daemon — el token no queda guardado en la regla.'"
      />
    </span>
    <KeyValueRows
      :model-value="headers()"
      key-placeholder="Authorization"
      value-placeholder="Bearer ${DEPLOY_TOKEN}"
      add-label="+ header"
      @update:model-value="(v) => emit('patch', { headers: Object.keys(v).length ? v : undefined })"
    />
  </div>

  <label class="ff-row">
    <span class="uc-label">Body</span>
    <textarea
      class="ff-field ff-mono ff-textarea"
      rows="3"
      :value="bodyText()"
      placeholder='{ "pr": "{{event.payload.pr.number}}" }'
      @input="setBody(($event.target as HTMLTextAreaElement).value)"
    />
  </label>

  <label class="ff-row ff-narrow">
    <span class="uc-label">Timeout (ms)</span>
    <input
      class="ff-field ff-mono"
      type="number"
      min="1"
      :value="typeof entry.timeoutMs === 'number' ? entry.timeoutMs : ''"
      placeholder="default"
      @input="setTimeoutMs(($event.target as HTMLInputElement).value)"
    />
  </label>
</template>

<style scoped src="@/ui/form-fields.css"></style>
