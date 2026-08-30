<script setup lang="ts">
// Los campos propios de UNA acción, según su tipo.
//
// Es el corte que hace que agregar un tipo de acción toque UN archivo: el
// contenedor (`ActionsEditor`) se ocupa del orden, el alta y la baja —que son
// iguales para todos los tipos— y acá vive lo único que los distingue.

type Entry = Record<string, unknown> & { action: string }

const props = defineProps<{
  entry: Entry
  agentIds?: string[]
  actionIds?: string[]
}>()

const emit = defineEmits<{
  (e: 'patch', changes: Record<string, unknown>): void
}>()

function str(key: string): string {
  const v = props.entry[key]
  return typeof v === 'string' ? v : ''
}

/** El body de una acción http se edita como texto porque puede ser cualquier
 *  JSON, y se guarda como string si no parsea — así un JSON a medio escribir
 *  no se pierde al cerrar el modal. */
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

const value = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value
</script>

<template>
  <label v-if="entry.action === 'agent'" class="af-row">
    <span class="af-lbl">Agente</span>
    <select
      v-if="agentIds?.length"
      class="af-field"
      :value="str('agentId')"
      @change="emit('patch', { agentId: value($event) })"
    >
      <option value="" disabled>— Agente —</option>
      <option v-for="id in agentIds" :key="id" :value="id">{{ id }}</option>
    </select>
    <input
      v-else
      class="af-field af-mono"
      :value="str('agentId')"
      placeholder="id del agente"
      @input="emit('patch', { agentId: value($event) })"
    />
  </label>

  <template v-if="entry.action === 'http'">
    <div class="af-row af-row-split">
      <label class="af-sub af-sub-method">
        <span class="af-lbl">Método</span>
        <select
          class="af-field"
          :value="str('method') || 'POST'"
          @change="emit('patch', { method: value($event) })"
        >
          <option v-for="m in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
      <label class="af-sub">
        <span class="af-lbl">URL</span>
        <input
          class="af-field af-mono"
          :value="str('url')"
          placeholder="https://hooks.internal/deploy"
          @input="emit('patch', { url: value($event) })"
        />
      </label>
    </div>
    <label class="af-row">
      <span class="af-lbl">Body</span>
      <textarea
        class="af-field af-mono af-textarea"
        rows="3"
        :value="bodyText()"
        placeholder='{ "pr": "{{event.payload.pr.number}}" }'
        @input="setBody(($event.target as HTMLTextAreaElement).value)"
      />
    </label>
    <p class="af-hint">
      <code v-pre>{{event.payload...}}</code> se reemplaza por el valor del evento.
      <code>${SECRETO}</code> lo resuelve el daemon — el token no queda guardado en la regla.
    </p>
  </template>

  <label v-if="entry.action === 'emit'" class="af-row">
    <span class="af-lbl">Tipo de evento</span>
    <input
      class="af-field af-mono"
      :value="str('type')"
      placeholder="intake.classified"
      @input="emit('patch', { type: value($event) })"
    />
  </label>

  <label v-if="entry.action === 'ref'" class="af-row">
    <span class="af-lbl">Acción</span>
    <select
      v-if="actionIds?.length"
      class="af-field"
      :value="str('actionId')"
      @change="emit('patch', { actionId: value($event) })"
    >
      <option value="" disabled>— Acción —</option>
      <option v-for="id in actionIds" :key="id" :value="id">{{ id }}</option>
    </select>
    <input
      v-else
      class="af-field af-mono"
      :value="str('actionId')"
      placeholder="id de la acción"
      @input="emit('patch', { actionId: value($event) })"
    />
    <span class="af-hint">
      Definida aparte y compartida: editarla cambia todas las reglas que la usan.
    </span>
  </label>

  <label v-if="entry.action === 'tool'" class="af-row">
    <span class="af-lbl">Tool</span>
    <input
      class="af-field af-mono"
      :value="str('tool')"
      placeholder="request_slack_review"
      @input="emit('patch', { tool: value($event) })"
    />
  </label>
</template>

<style scoped>
.af-row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.af-row-split {
  flex-direction: row;
  gap: 0.4rem;
}
.af-sub {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  flex: 1;
  min-width: 0;
}
.af-sub-method { flex: 0 0 7rem; }

.af-lbl {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.af-field {
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: var(--panel-alt);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  width: 100%;
  box-sizing: border-box;
  border-radius: var(--radius-sm);
}
.af-mono { font-family: var(--font-mono); }
.af-textarea {
  height: auto;
  padding: 0.3rem 0.5ch;
  resize: vertical;
  line-height: 1.5;
}
.af-hint {
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  line-height: 1.5;
  margin: 0;
}
.af-hint code {
  font-family: var(--font-mono);
  color: var(--fg-mute);
}
</style>
