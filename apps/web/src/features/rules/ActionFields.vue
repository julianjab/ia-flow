<script setup lang="ts">
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue';
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
// Un control en vez de `<select>`-o-`<input>`. Esa bifurcación era el síntoma:
// la lista NUNCA es autoridad —un agente o una acción pueden no estar creados
// todavía— pero tampoco se quiere tipear a ciegas cuando sí se conoce.
const asOptions = (ids?: string[]): ComboOption[] => (ids ?? []).map((value) => ({ value }));
const one = (v: string | string[]) => (Array.isArray(v) ? (v[0] ?? '') : v);
</script>

<template>
  <!-- `div` y no `label`: un `<label>` reenvía el click de cualquier
       descendiente a su PRIMER control, y en un ComboBox con chips ése es la
       ✕ del primer chip. Ver el comentario en `ui/ComboBox.vue`. -->
  <div v-if="entry.action === 'agent'" class="af-row">
    <span class="af-lbl">Agente</span>
    <ComboBox
      allow-custom
      class="af-combo"
      :model-value="str('agentId')"
      :options="asOptions(agentIds)"
      placeholder="id del agente"
      empty-text="Ninguno conocido coincide — se guarda igual"
      @update:model-value="(v) => emit('patch', { agentId: one(v) })"
    />
  </div>

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

  <!-- Mismo motivo que arriba: `div` y no `label`. -->
  <div v-if="entry.action === 'ref'" class="af-row">
    <span class="af-lbl">Acción</span>
    <ComboBox
      allow-custom
      class="af-combo"
      :model-value="str('actionId')"
      :options="asOptions(actionIds)"
      placeholder="id de la acción"
      empty-text="Ninguna conocida coincide — se guarda igual"
      @update:model-value="(v) => emit('patch', { actionId: one(v) })"
    />
    <span class="af-hint">
      Definida aparte y compartida: editarla cambia todas las reglas que la usan.
    </span>
  </div>

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
/* Un ComboBox trae su propia caja (`.cb-box`: borde, alto, chips). Pasarle
   `.af-field` le imponía 22px de alto y un segundo borde encima, y su input
   se desbordaba sobre el control de abajo. Acá sólo se le da el ancho. */
.af-combo { width: 100%; min-width: 0; }

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
