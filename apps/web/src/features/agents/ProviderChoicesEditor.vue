<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentProviderChoice } from '@ia-flow/shared'

// v-model over AgentProviderChoice[] — el orden importa: el engine evalúa
// `when`/`whenText` en el orden declarado y elige el primer candidato
// elegible (ver AgentProviderSchema en packages/shared/src/schemas.ts). Los
// seleccionados se tildan con un checkbox y se reordenan arrastrando (con
// botones ↑/↓ como alternativa accesible por teclado — drag nativo no lo es).

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

const selectedIds = computed(() => new Set(choices.value.map((c) => c.providerId)))
const available = computed(() => splitLocalRemote(props.providers.filter((p) => !selectedIds.value.has(p.id))))

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

function nameFor(p: ProviderOption): string {
  return p.name ?? p.id
}
</script>

<template>
  <div class="pce">
    <div class="pce-selected">
      <p class="pce-lbl">Seleccionados — arrastrá para reordenar</p>
      <p v-if="!choices.length" class="pce-empty">Ninguno todavía — tildá al menos uno abajo.</p>
      <div
        v-for="(c, i) in choices"
        :key="c.providerId"
        class="pce-row"
        draggable="true"
        @dragstart="onDragStart(i, $event)"
        @dragover="onDragOver"
        @drop="onDrop(i)"
      >
        <span class="pce-drag" aria-hidden="true" title="Arrastrar para reordenar">⠿</span>
        <span class="pce-pos" :title="`Orden ${i + 1} — se evalúa antes que los siguientes`">{{ i + 1 }}</span>

        <label class="pce-check">
          <input
            type="checkbox"
            checked
            @change="toggle(c.providerId, ($event.target as HTMLInputElement).checked)"
          />
          <span>{{ nameFor(providers.find((p) => p.id === c.providerId) ?? { id: c.providerId }) }}</span>
        </label>

        <input
          :value="c.whenText ?? ''"
          class="pce-when"
          placeholder="Cuándo (texto libre, opcional)"
          @input="updateChoice(i, { whenText: ($event.target as HTMLInputElement).value || undefined })"
        />

        <div class="pce-move">
          <button
            type="button"
            class="pce-move-btn"
            aria-label="Subir"
            :disabled="i === 0"
            @click="move(i, -1)"
          >↑</button>
          <button
            type="button"
            class="pce-move-btn"
            aria-label="Bajar"
            :disabled="i === choices.length - 1"
            @click="move(i, 1)"
          >↓</button>
        </div>
      </div>
      <p v-if="choices.length" class="pce-order-hint">
        Orden de evaluación: {{ choices.map((c) => nameFor(providers.find((p) => p.id === c.providerId) ?? { id: c.providerId })).join(' → ') }}
      </p>
    </div>

    <div class="pce-available">
      <p class="pce-lbl">Agregar</p>
      <template v-if="available.local.length">
        <p class="pce-group-lbl">Locales</p>
        <label v-for="p in available.local" :key="p.id" class="pce-check pce-check-avail">
          <input type="checkbox" :checked="false" @change="toggle(p.id, ($event.target as HTMLInputElement).checked)" />
          <span>{{ nameFor(p) }}</span>
        </label>
      </template>
      <template v-if="available.remote.length">
        <p class="pce-group-lbl">Remotos</p>
        <label v-for="p in available.remote" :key="p.id" class="pce-check pce-check-avail">
          <input type="checkbox" :checked="false" @change="toggle(p.id, ($event.target as HTMLInputElement).checked)" />
          <span>{{ nameFor(p) }}</span>
        </label>
      </template>
      <p v-if="!available.local.length && !available.remote.length" class="pce-empty">
        Ya están todos seleccionados.
      </p>
    </div>
  </div>
</template>

<style scoped>
.pce { display: flex; flex-direction: column; gap: 0.75rem; }

.pce-selected, .pce-available { display: flex; flex-direction: column; gap: 0.3rem; }

.pce-lbl {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.pce-group-lbl {
  margin: 0.2rem 0 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}

.pce-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.2rem 0.3rem;
  border: 1px solid var(--border);
  background: var(--panel);
  cursor: grab;
}
.pce-row:active { cursor: grabbing; }

.pce-drag { flex-shrink: 0; color: var(--fg-dim); user-select: none; }
.pce-pos {
  flex-shrink: 0;
  width: 1.4rem;
  text-align: center;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}

.pce-check {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex: 1 1 12rem;
  min-width: 0;
  font-size: var(--fs-body-sm);
  color: var(--fg);
  cursor: pointer;
  user-select: none;
}
.pce-check input { cursor: pointer; flex-shrink: 0; }
.pce-check span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pce-check-avail { padding: 0.15rem 0.3rem; }

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

.pce-empty { font-size: var(--fs-body-sm); color: var(--fg-dim); margin: 0; }

.pce-order-hint {
  margin: 0.15rem 0 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  font-family: var(--font-mono);
}
</style>
