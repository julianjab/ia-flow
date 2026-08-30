<script setup lang="ts">
import type { ActionFormEmits, ActionFormProps } from '@/features/rules/actionForms/types'
import JsonField from '@/features/rules/actionForms/JsonField.vue'

// `emit` — publicar un evento derivado.

const props = defineProps<ActionFormProps>()
const emit = defineEmits<ActionFormEmits>()

const str = (key: string) => (typeof props.entry[key] === 'string' ? (props.entry[key] as string) : '')

type Scope = { projectId?: string; repos?: string[]; issueId?: string; prNumber?: number }
const scope = () => (props.entry.scope ?? {}) as Scope

/** Un ámbito vacío se borra en vez de guardarse como `{}`: el evento derivado
 *  hereda el del que lo provocó, y un objeto vacío parece una decisión. */
function patchScope(changes: Scope) {
  const next: Record<string, unknown> = { ...scope(), ...changes }
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete next[k]
  }
  emit('patch', { scope: Object.keys(next).length ? next : undefined })
}

function setRepos(raw: string) {
  patchScope({ repos: raw.split(',').map((r) => r.trim()).filter(Boolean) })
}

function setPrNumber(raw: string) {
  const n = Number.parseInt(raw, 10)
  patchScope({ prNumber: Number.isFinite(n) ? n : undefined })
}
</script>

<template>
  <label class="ff-row">
    <span class="uc-label">Tipo de evento</span>
    <input
      class="ff-field ff-mono"
      :value="str('type')"
      placeholder="intake.classified"
      @input="emit('patch', { type: ($event.target as HTMLInputElement).value })"
    />
  </label>

  <div class="ff-row">
    <span class="uc-label">Payload</span>
    <JsonField
      :model-value="entry.payload"
      placeholder='{ "clasificacion": "{{event.payload.label}}" }'
      @update:model-value="(v) => emit('patch', { payload: v })"
    />
  </div>

  <!-- El ámbito va plegado: lo normal es heredarlo del evento que provocó
       éste, y sólo un normalizador (un triager que decide de qué proyecto es un
       mensaje suelto) necesita escribirlo. -->
  <details class="ff-more">
    <summary class="uc-label">Ámbito del evento derivado (opcional)</summary>
    <div class="ff-more-body">
      <div class="ff-row ff-row-split">
        <label class="ff-sub">
          <span class="uc-label">Proyecto</span>
          <input
            class="ff-field ff-mono"
            :value="scope().projectId ?? ''"
            placeholder="hereda el del evento"
            @input="patchScope({ projectId: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="ff-sub">
          <span class="uc-label">Repos</span>
          <input
            class="ff-field ff-mono"
            :value="(scope().repos ?? []).join(', ')"
            placeholder="uno, otro"
            @change="setRepos(($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <div class="ff-row ff-row-split">
        <label class="ff-sub">
          <span class="uc-label">Issue</span>
          <input
            class="ff-field ff-mono"
            :value="scope().issueId ?? ''"
            @input="patchScope({ issueId: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="ff-sub ff-sub-narrow">
          <span class="uc-label">PR</span>
          <input
            class="ff-field ff-mono"
            type="number"
            :value="scope().prNumber ?? ''"
            @input="setPrNumber(($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
    </div>
  </details>
</template>

<style scoped src="@/ui/form-fields.css"></style>
