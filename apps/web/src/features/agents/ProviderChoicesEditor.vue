<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentProviderChoice, WhenCondition } from '@ia-flow/shared'
import WhenConditionsEditor from '@/features/agents/WhenConditionsEditor.vue'

// v-model over AgentProviderChoice[] — el orden importa: el engine evalúa
// `when`/`whenText` en el orden declarado y elige el primer candidato
// elegible (ver AgentProviderSchema en packages/shared/src/schemas.ts). El
// control se ve y se abre como un <select> nativo (mismo estilo que
// AgentDefinitionSection `.input`); a diferencia de uno, el menú se queda
// abierto para tildar varios. El orden de evaluación se edita aparte,
// debajo, arrastrando (con botones ↑/↓ como alternativa por teclado — drag
// nativo no lo es).
//
// Cada candidato tiene DOS formas de condicionarse, y son distintas:
//
//   `when`      condiciones estructuradas contra los campos del issue, que
//               evalúa `evalWhen` sin I/O (`filterProviderCandidates`). Es un
//               FILTRO: un candidato que no matchea sale de la lista. Soporta
//               grupos OR — el badge AND/OR entre condiciones — igual que el
//               `when` de activación del agente, porque es el mismo DSL.
//   `whenText`  texto libre. NO filtra: sólo desempata con Haiku cuando más
//               de un candidato sobrevivió al filtro y al menos uno lo trae.
//
// El `when` estructurado existía en el schema desde el principio pero no
// tenía control acá: era editable sólo por YAML/API. Se reusa el mismo
// componente que la activación en vez de una copia — es el mismo contrato.

interface ProviderOption { id: string; name?: string }

const props = defineProps<{
  modelValue: AgentProviderChoice[]
  providers: ProviderOption[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: AgentProviderChoice[]): void
}>()

// Mismo patrón de eco-guard que WhenConditionsEditor: el padre puede devolver
// el array recién emitido (p. ej. por otro watcher), y sin esto una fila
// recién agregada con `whenText: ''` se perdería antes de que el usuario
// llegue a escribirla.
const choices = ref<AgentProviderChoice[]>([...props.modelValue])
let lastEmitted: string | null = null

watch(
  () => props.modelValue,
  (next) => {
    if (JSON.stringify(next ?? []) === lastEmitted) return
    choices.value = [...(next ?? [])]
  },
)

function emitChoices(next: AgentProviderChoice[]) {
  choices.value = next
  lastEmitted = JSON.stringify(next)
  emit('update:modelValue', next)
}

// Los ids `remote:<registrationId>` (ver RemoteAgentProvider.remoteProviderId)
// suelen tener un `name` casi idéntico al provider local que envuelven (p.
// ej. "Claude API (headless)" vs "Claude API (headless) (mi-mac)") — sin
// agruparlos, el picker luce como si el mismo provider apareciera duplicado.
function splitLocalRemote(list: ProviderOption[]) {
  return {
    local: list.filter((p) => !p.id.startsWith('remote:')),
    remote: list.filter((p) => p.id.startsWith('remote:')),
  }
}

/** Qué candidato tiene el editor de condiciones abierto (índice), si alguno.
 *  Uno a la vez: el editor es alto y el menú ya es denso. */
const expandedWhen = ref<number | null>(null)

function toggleWhen(i: number): void {
  expandedWhen.value = expandedWhen.value === i ? null : i
}

/** `when` puede venir como array (formato nuevo) o como record plano
 *  (legacy, todo-AND). El editor sólo habla array, así que el record se
 *  convierte al abrirlo — y se emite siempre array. */
function whenOf(choice: AgentProviderChoice): WhenCondition[] {
  const when = choice.when
  if (!when) return []
  if (Array.isArray(when)) return when
  return Object.entries(when).map(([field, value]) => ({ field, op: '=', value }))
}

function whenCount(choice: AgentProviderChoice): number {
  return whenOf(choice).length
}

const selectedIds = computed(() => new Set(choices.value.map((c) => c.providerId)))
// Sin seleccionar todavía — se ofrecen como checkbox al final del mismo
// desplegable. Los ya elegidos viven arriba, como filas arrastrables (ver
// template) en vez de duplicarse acá con un checkbox tildado.
const availableProviders = computed(() =>
  splitLocalRemote(props.providers.filter((p) => !selectedIds.value.has(p.id))),
)

function toggle(providerId: string, checked: boolean) {
  if (checked) {
    emitChoices([...choices.value, { providerId }])
  } else {
    emitChoices(choices.value.filter((c) => c.providerId !== providerId))
  }
}

function updateChoice(i: number, patch: Partial<AgentProviderChoice>) {
  emitChoices(choices.value.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
}

function move(i: number, dir: -1 | 1) {
  const j = i + dir
  if (j < 0 || j >= choices.value.length) return
  const next = [...choices.value]
  ;[next[i], next[j]] = [next[j], next[i]]
  emitChoices(next)
}

function reorder(from: number, to: number) {
  if (from === to) return
  const next = [...choices.value]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  emitChoices(next)
}

// Drag nativo (HTML5) — sin librería: dataTransfer lleva el índice de
// origen, drop en la fila destino reordena. `dragover` necesita
// preventDefault para que el navegador permita soltar ahí.
const dragIndex = ref<number | null>(null)

function onDragStart(i: number, event: DragEvent) {
  dragIndex.value = i
  event.dataTransfer?.setData('text/plain', String(i))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onDragOver(event: DragEvent) {
  event.preventDefault()
}
function onDrop(i: number) {
  if (dragIndex.value !== null) reorder(dragIndex.value, i)
  dragIndex.value = null
}

function nameFor(providerId: string): string {
  return props.providers.find((p) => p.id === providerId)?.name ?? providerId
}

// ─── Trigger + menú (mismo patrón que ui/AutocompleteSelect: abre al foco/
// clic, se cierra al clic afuera o Escape) ─────────────────────────────────
const open = ref(false)
const rootEl = ref<HTMLDivElement | null>(null)

const summary = computed(() => {
  if (!choices.value.length) return 'Seleccioná uno o más providers…'
  const names = choices.value.map((c) => nameFor(c.providerId))
  return names.length > 1 ? `${names[0]} +${names.length - 1} más` : names[0]
})

function onDocumentClick(event: MouseEvent) {
  if (!rootEl.value) return
  if (!rootEl.value.contains(event.target as Node)) open.value = false
}

watch(open, (v) => {
  if (v) document.addEventListener('mousedown', onDocumentClick)
  else document.removeEventListener('mousedown', onDocumentClick)
})

function onTriggerKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false
  else if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
    event.preventDefault()
    open.value = true
  }
}
</script>

<template>
  <div ref="rootEl" class="pce">
    <div class="pce-trigger-wrap">
      <button
        type="button"
        class="pce-trigger"
        :aria-expanded="open"
        @click="open = !open"
        @focus="open = true"
        @keydown="onTriggerKeydown"
      >
        <span class="pce-trigger-text" :class="{ 'pce-trigger-text--empty': !choices.length }">{{ summary }}</span>
        <span class="pce-caret" aria-hidden="true">▾</span>
      </button>

      <div v-if="open" class="pce-menu" role="listbox" aria-multiselectable="true">
        <template v-if="choices.length">
          <p class="pce-group-lbl">
            {{ choices.length > 1 ? 'Seleccionados — arrastrá para reordenar' : 'Seleccionado' }}
          </p>
          <template v-for="(c, i) in choices" :key="c.providerId">
            <div
              class="pce-row"
              :draggable="choices.length > 1"
              @dragstart="onDragStart(i, $event)"
              @dragover="onDragOver"
              @drop="onDrop(i)"
            >
            <span v-if="choices.length > 1" class="pce-drag" aria-hidden="true" title="Arrastrar para reordenar">⠿</span>
            <span v-if="choices.length > 1" class="pce-pos" :title="`Orden ${i + 1}`">{{ i + 1 }}</span>
            <span class="pce-row-name">{{ nameFor(c.providerId) }}</span>
            <input
              :value="c.whenText ?? ''"
              class="pce-when"
              placeholder="Cuándo (texto libre, opcional)"
              @click.stop
              @input="updateChoice(i, { whenText: ($event.target as HTMLInputElement).value || undefined })"
            />
            <div v-if="choices.length > 1" class="pce-move">
              <button type="button" class="pce-move-btn" aria-label="Subir" :disabled="i === 0" @click="move(i, -1)">↑</button>
              <button
                type="button"
                class="pce-move-btn"
                aria-label="Bajar"
                :disabled="i === choices.length - 1"
                @click="move(i, 1)"
              >↓</button>
            </div>
            <button
              type="button"
              class="pce-cond"
              :class="{ 'pce-cond--on': whenCount(c) > 0, 'pce-cond--open': expandedWhen === i }"
              :title="
                whenCount(c)
                  ? `${whenCount(c)} condición(es) — sólo es candidato si se cumplen`
                  : 'Sin condiciones — siempre candidato'
              "
              @click.stop="toggleWhen(i)"
            >
              cond{{ whenCount(c) ? ` ${whenCount(c)}` : '' }}
            </button>
            <button type="button" class="pce-remove" aria-label="Quitar" @click="toggle(c.providerId, false)">✕</button>
          </div>
          <div v-if="expandedWhen === i" class="pce-when-panel" @click.stop>
            <p class="pce-when-hint">
              Condiciones contra los campos del issue. Si no se cumplen, este candidato NO se
              considera y sigue el próximo de la lista. El badge entre condiciones alterna AND/OR.
            </p>
              <WhenConditionsEditor
                :model-value="whenOf(c)"
                @update:model-value="updateChoice(i, { when: $event.length ? $event : undefined })"
              />
            </div>
          </template>
        </template>

        <template v-if="availableProviders.local.length">
          <p class="pce-group-lbl">Locales</p>
          <label v-for="p in availableProviders.local" :key="p.id" class="pce-option">
            <input type="checkbox" :checked="false" @change="toggle(p.id, ($event.target as HTMLInputElement).checked)" />
            <span>{{ p.name ?? p.id }}</span>
          </label>
        </template>
        <template v-if="availableProviders.remote.length">
          <p class="pce-group-lbl">Remotos</p>
          <label v-for="p in availableProviders.remote" :key="p.id" class="pce-option">
            <input type="checkbox" :checked="false" @change="toggle(p.id, ($event.target as HTMLInputElement).checked)" />
            <span>{{ p.name ?? p.id }}</span>
          </label>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pce { display: flex; flex-direction: column; gap: 0.5rem; }

.pce-trigger-wrap { position: relative; }

.pce-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border-hi);
  background: var(--panel);
  color: var(--fg);
  font-size: 0.875rem;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  outline: none;
}
.pce-trigger:focus { border-color: var(--accent); }
.pce-trigger-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pce-trigger-text--empty { color: var(--fg-dim); }
.pce-caret { flex-shrink: 0; color: var(--fg-dim); font-size: 0.7rem; }

.pce-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 300;
  background: var(--panel);
  border: 1px solid var(--border-hi);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
  max-height: 260px;
  overflow-y: auto;
  padding: 0.3rem 0;
}
.pce-group-lbl {
  margin: 0.3rem 0.75rem 0.15rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.pce-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  font-size: 0.83rem;
  color: var(--fg);
  cursor: pointer;
  user-select: none;
}
.pce-option:hover { background: var(--panel-hi); }
.pce-option input { cursor: pointer; flex-shrink: 0; }

.pce-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0 0.5rem 0.3rem;
  padding: 0.25rem 0.4rem;
  border: 1px solid var(--border);
  background: var(--panel-hi);
}
.pce-row[draggable='true'] { cursor: grab; }
.pce-row[draggable='true']:active { cursor: grabbing; }

.pce-drag { flex-shrink: 0; color: var(--fg-dim); user-select: none; }
.pce-pos {
  flex-shrink: 0;
  width: 1.4rem;
  text-align: center;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.pce-row-name {
  flex: 1 1 10rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body-sm);
  color: var(--fg);
}

.pce-cond {
  flex-shrink: 0;
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: none;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  cursor: pointer;
}
.pce-cond:hover {
  border-color: var(--border-hi);
  color: var(--fg);
}
.pce-cond--on {
  color: var(--ai);
  border-color: var(--ai);
}
.pce-cond--open {
  background: var(--panel-hi);
  color: var(--fg);
}
.pce-when-panel {
  padding: 0.4rem 0.5rem 0.6rem 2ch;
  border-left: 1px solid var(--border);
  margin-left: 1ch;
}
.pce-when-hint {
  margin: 0 0 0.4rem;
  color: var(--fg-dim);
  font-size: var(--fs-micro);
}

.pce-when {
  flex: 1 1 10rem;
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  min-width: 0;
}

.pce-move { display: flex; gap: 0.15rem; flex-shrink: 0; }
.pce-move-btn {
  width: 1.6rem;
  height: var(--row-h);
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg-mute);
  cursor: pointer;
}
.pce-move-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.pce-move-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.pce-remove {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--danger);
  cursor: pointer;
  font-size: var(--fs-micro);
  padding: 0 0.3ch;
  height: var(--row-h);
  line-height: var(--row-h);
}
.pce-remove:hover { color: var(--fg); background: var(--danger); }
</style>
