<script setup lang="ts">
import type { RuleActionEntry } from '@ia-flow/shared'
import { computed } from 'vue'

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
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: RuleActionEntry[]): void
}>()

type Entry = Record<string, unknown> & { action: string; continueOnError?: boolean }

const entries = computed<Entry[]>(() => props.modelValue as unknown as Entry[])

const KIND_LABELS: Record<string, string> = {
  agent: 'Correr un agente',
  http: 'Llamar a una API',
  emit: 'Emitir un evento',
  tool: 'Invocar una tool',
}

function labelFor(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/** Una acción nueva nace con los campos obligatorios de su tipo ya presentes,
 *  para que el form no arranque en un estado que el server rechaza. */
function blankFor(kind: string): Entry {
  if (kind === 'http') return { action: 'http', url: '', method: 'POST' }
  if (kind === 'emit') return { action: 'emit', type: '' }
  if (kind === 'tool') return { action: 'tool', tool: '' }
  return { action: 'agent', agentId: props.agentIds?.[0] ?? '' }
}

function push(next: Entry[]) {
  emit('update:modelValue', next as unknown as RuleActionEntry[])
}

function addAction() {
  const kind = props.availableKinds[0] ?? 'agent'
  push([...entries.value, blankFor(kind)])
}

function removeAction(i: number) {
  push(entries.value.filter((_, idx) => idx !== i))
}

function patch(i: number, changes: Partial<Entry>) {
  push(entries.value.map((e, idx) => (idx === i ? { ...e, ...changes } : e)))
}

/** Cambiar el tipo REEMPLAZA la entrada en vez de mergear: los campos de una
 *  acción `http` no significan nada en una `emit`, y arrastrarlos dejaría
 *  basura que el server rechaza sin que se vea en el form. */
function changeKind(i: number, kind: string) {
  const keep = entries.value[i]?.continueOnError
  const next = blankFor(kind)
  if (keep) next.continueOnError = keep
  push(entries.value.map((e, idx) => (idx === i ? next : e)))
}

function move(i: number, delta: number) {
  const target = i + delta
  if (target < 0 || target >= entries.value.length) return
  const next = [...entries.value]
  const [moved] = next.splice(i, 1)
  next.splice(target, 0, moved)
  push(next)
}

function str(e: Entry, key: string): string {
  const v = e[key]
  return typeof v === 'string' ? v : ''
}

/** El body de una acción http se edita como texto porque puede ser cualquier
 *  JSON, y se guarda como string si no parsea — así un JSON a medio escribir no
 *  se pierde al cerrar el modal. */
function bodyText(e: Entry): string {
  const v = e.body
  if (v === undefined) return ''
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
}

function setBody(i: number, raw: string) {
  if (!raw.trim()) {
    patch(i, { body: undefined })
    return
  }
  try {
    patch(i, { body: JSON.parse(raw) })
  } catch {
    patch(i, { body: raw })
  }
}
</script>

<template>
  <div class="ae">
    <div v-for="(entry, i) in entries" :key="i" class="ae-card">
      <div class="ae-head">
        <span class="ae-idx">{{ i + 1 }}</span>
        <select
          class="ae-field ae-kind"
          :value="entry.action"
          @change="changeKind(i, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="k in availableKinds" :key="k" :value="k">{{ labelFor(k) }}</option>
        </select>
        <div class="ae-spacer" />
        <button
          type="button"
          class="ae-icon"
          :disabled="i === 0"
          aria-label="Subir"
          @click="move(i, -1)"
        >↑</button>
        <button
          type="button"
          class="ae-icon"
          :disabled="i === entries.length - 1"
          aria-label="Bajar"
          @click="move(i, 1)"
        >↓</button>
        <button type="button" class="ae-remove" aria-label="Quitar acción" @click="removeAction(i)">✕</button>
      </div>

      <div class="ae-body">
        <!-- agent -->
        <label v-if="entry.action === 'agent'" class="ae-row">
          <span class="ae-lbl">Agente</span>
          <select
            v-if="agentIds?.length"
            class="ae-field"
            :value="str(entry, 'agentId')"
            @change="patch(i, { agentId: ($event.target as HTMLSelectElement).value })"
          >
            <option value="" disabled>— Agente —</option>
            <option v-for="id in agentIds" :key="id" :value="id">{{ id }}</option>
          </select>
          <input
            v-else
            class="ae-field ae-mono"
            :value="str(entry, 'agentId')"
            placeholder="id del agente"
            @input="patch(i, { agentId: ($event.target as HTMLInputElement).value })"
          />
        </label>

        <!-- http -->
        <template v-if="entry.action === 'http'">
          <div class="ae-row ae-row-split">
            <label class="ae-sub ae-sub-method">
              <span class="ae-lbl">Método</span>
              <select
                class="ae-field"
                :value="str(entry, 'method') || 'POST'"
                @change="patch(i, { method: ($event.target as HTMLSelectElement).value })"
              >
                <option v-for="m in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']" :key="m" :value="m">{{ m }}</option>
              </select>
            </label>
            <label class="ae-sub">
              <span class="ae-lbl">URL</span>
              <input
                class="ae-field ae-mono"
                :value="str(entry, 'url')"
                placeholder="https://hooks.internal/deploy"
                @input="patch(i, { url: ($event.target as HTMLInputElement).value })"
              />
            </label>
          </div>
          <label class="ae-row">
            <span class="ae-lbl">Body</span>
            <textarea
              class="ae-field ae-mono ae-textarea"
              rows="3"
              :value="bodyText(entry)"
              placeholder='{ "pr": "{{event.payload.pr.number}}" }'
              @input="setBody(i, ($event.target as HTMLTextAreaElement).value)"
            />
          </label>
          <p class="ae-hint">
            <code v-pre>{{event.payload...}}</code> se reemplaza por el valor del evento.
            <code>${SECRETO}</code> lo resuelve el daemon — el token no queda guardado en la regla.
          </p>
        </template>

        <!-- emit -->
        <label v-if="entry.action === 'emit'" class="ae-row">
          <span class="ae-lbl">Tipo de evento</span>
          <input
            class="ae-field ae-mono"
            :value="str(entry, 'type')"
            placeholder="intake.classified"
            @input="patch(i, { type: ($event.target as HTMLInputElement).value })"
          />
        </label>

        <!-- tool -->
        <label v-if="entry.action === 'tool'" class="ae-row">
          <span class="ae-lbl">Tool</span>
          <input
            class="ae-field ae-mono"
            :value="str(entry, 'tool')"
            placeholder="request_slack_review"
            @input="patch(i, { tool: ($event.target as HTMLInputElement).value })"
          />
        </label>

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

.ae-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.4rem;
  background: var(--panel-hi);
  border-bottom: 1px solid var(--border);
}

.ae-idx {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  min-width: 1.2ch;
  text-align: center;
}

.ae-kind { flex: 0 1 14rem; }
.ae-spacer { flex: 1 1 auto; }

.ae-body {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.6rem;
}

.ae-row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.ae-row-split {
  flex-direction: row;
  gap: 0.4rem;
}
.ae-sub {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  flex: 1 1 auto;
  min-width: 0;
}
.ae-sub-method { flex: 0 0 7rem; }

.ae-lbl {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
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
.ae-mono { font-family: var(--font-mono); }
.ae-textarea {
  height: auto;
  padding: 0.3rem 0.5ch;
  resize: vertical;
  line-height: 1.5;
}

.ae-hint {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  line-height: 1.5;
}
.ae-hint code {
  font-family: var(--font-mono);
  color: var(--fg-mute);
}

.ae-check {
  display: flex;
  align-items: center;
  gap: 0.45ch;
  font-size: var(--fs-body-sm);
  color: var(--fg-mute);
  cursor: pointer;
}

.ae-icon,
.ae-remove {
  background: none;
  border: none;
  cursor: pointer;
  font-size: var(--fs-micro);
  height: var(--row-h);
  line-height: var(--row-h);
  padding: 0 0.4ch;
  color: var(--fg-dim);
}
.ae-icon:hover:not(:disabled) { color: var(--fg); }
.ae-icon:disabled { opacity: 0.3; cursor: default; }
.ae-remove { color: var(--danger); }
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
</style>
