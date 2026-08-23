<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentProviderChoice } from '@ia-flow/shared'

// v-model over AgentProviderChoice[] — el orden importa: el engine evalúa
// `when`/`whenText` en el orden declarado y elige el primer candidato
// elegible (ver AgentProviderSchema en packages/shared/src/schemas.ts).

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
const localProviders = computed(() => props.providers.filter((p) => !p.id.startsWith('remote:')))
const remoteProviders = computed(() => props.providers.filter((p) => p.id.startsWith('remote:')))

function addChoice() {
  const used = new Set(choices.value.map((c) => c.providerId))
  const next = props.providers.find((p) => !used.has(p.id))?.id ?? props.providers[0]?.id ?? ''
  emitChoices([...choices.value, { providerId: next }])
}

function removeChoice(i: number) {
  emitChoices(choices.value.filter((_, idx) => idx !== i))
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

function nameFor(providerId: string): string {
  return props.providers.find((p) => p.id === providerId)?.name ?? providerId
}
</script>

<template>
  <div class="pce">
    <div v-for="(c, i) in choices" :key="i" class="pce-row">
      <span class="pce-pos" :title="`Orden ${i + 1} — se evalúa antes que los siguientes`">{{ i + 1 }}</span>

      <div class="pce-cell pce-cell-provider">
        <span class="pce-lbl">Provider</span>
        <select
          :value="c.providerId"
          class="pce-field"
          @change="updateChoice(i, { providerId: ($event.target as HTMLSelectElement).value })"
        >
          <optgroup v-if="localProviders.length" label="Locales">
            <option v-for="p in localProviders" :key="p.id" :value="p.id">{{ p.name ?? p.id }}</option>
          </optgroup>
          <optgroup v-if="remoteProviders.length" label="Remotos">
            <option v-for="p in remoteProviders" :key="p.id" :value="p.id">{{ p.name ?? p.id }}</option>
          </optgroup>
        </select>
      </div>

      <div class="pce-cell pce-cell-when">
        <span class="pce-lbl">Cuándo (texto libre, opcional)</span>
        <input
          :value="c.whenText ?? ''"
          class="pce-field"
          :placeholder="`Siempre elegible — se evalúa vs. los candidatos anteriores`"
          @input="updateChoice(i, { whenText: ($event.target as HTMLInputElement).value || undefined })"
        />
      </div>

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

      <button
        type="button"
        class="pce-remove"
        aria-label="Quitar candidato"
        @click="removeChoice(i)"
      >✕</button>
    </div>

    <p v-if="!choices.length" class="pce-empty">Sin candidatos — agregá al menos uno.</p>

    <button type="button" class="pce-add" @click="addChoice">+ candidato</button>

    <p v-if="choices.length" class="pce-order-hint">
      Orden de evaluación: {{ choices.map((c) => nameFor(c.providerId)).join(' → ') }}
    </p>
  </div>
</template>

<style scoped>
.pce { display: flex; flex-direction: column; gap: 0.35rem; }

.pce-row {
  display: flex;
  align-items: flex-end;
  gap: 0.4rem;
}
.pce-pos {
  flex-shrink: 0;
  width: 1.4rem;
  height: var(--row-h);
  line-height: var(--row-h);
  text-align: center;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  border: 1px solid var(--border);
}
.pce-cell { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.pce-cell-provider { flex: 1 1 10rem; }
.pce-cell-when { flex: 1 1 10rem; }
.pce-lbl {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.pce-field {
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  width: 100%;
  box-sizing: border-box;
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

.pce-empty { font-size: var(--fs-body-sm); color: var(--fg-dim); margin: 0; }

.pce-add {
  align-self: flex-start;
  background: none;
  border: 1px dashed var(--border);
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  height: var(--row-h);
  padding: 0 1ch;
  cursor: pointer;
}
.pce-add:hover { border-color: var(--accent); color: var(--accent); }

.pce-order-hint {
  margin: 0.15rem 0 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  font-family: var(--font-mono);
}
</style>
