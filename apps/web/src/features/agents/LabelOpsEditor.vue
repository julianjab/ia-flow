<script setup lang="ts">
// Valor de la fila `Labels` dentro de los outcomes: chips con signo, donde el
// signo ES la operación. `+design` añade, `-design` quita. El signo viaja
// pegado a cada label en vez de haber listas separadas por acción, porque es
// como se piensa la operación ("agregá design, sacá wip") y es exactamente el
// formato que después viaja en el string `$labels:`.
//
// `=` (reemplazar por) es el tercer estado del mismo toggle: casi nunca se
// usa, pero sin él una config guardada con `=` quedaría imposible de editar.
import { computed, ref } from 'vue'
import {
  type LabelSign,
  type LabelToken,
  parseLabelTokens,
  serializeLabelTokens,
} from '@/features/agents/outcomes-serialization'

const props = defineProps<{
  /** Tokens serializados, ej. `"+design,-wip"`. */
  modelValue: string
  /** Catálogo de labels conocidas para sugerir. Puede venir vacío. */
  options?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const draft = ref('')
const listId = `loe-${Math.random().toString(36).slice(2, 9)}`

const tokens = computed<LabelToken[]>(() => parseLabelTokens(props.modelValue))

// Sólo sugerimos lo que todavía no está elegido — repetir una label ya puesta
// no tiene sentido en ninguno de los tres signos.
const suggestions = computed(() => {
  const taken = new Set(tokens.value.map((t) => t.label.toLowerCase()))
  return (props.options ?? []).filter((o) => !taken.has(o.toLowerCase()))
})

function emitTokens(next: LabelToken[]) {
  emit('update:modelValue', serializeLabelTokens(next))
}

const NEXT_SIGN: Record<LabelSign, LabelSign> = { '+': '-', '-': '=', '=': '+' }

function cycleSign(i: number) {
  emitTokens(
    tokens.value.map((t, idx) => (idx === i ? { ...t, sign: NEXT_SIGN[t.sign] } : t)),
  )
}

function removeToken(i: number) {
  emitTokens(tokens.value.filter((_, idx) => idx !== i))
}

function commitDraft() {
  const raw = draft.value.trim()
  if (!raw) return
  // Acepta pegar varias de una (`design, wip`) y respeta un signo escrito a
  // mano (`-wip`), que es lo que alguien acostumbrado al DSL va a tipear.
  const added = parseLabelTokens(raw)
  const taken = new Set(tokens.value.map((t) => t.label.toLowerCase()))
  const fresh = added.filter((t) => !taken.has(t.label.toLowerCase()))
  draft.value = ''
  if (fresh.length) emitTokens([...tokens.value, ...fresh])
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    commitDraft()
    return
  }
  if (e.key === 'Backspace' && !draft.value && tokens.value.length) {
    removeToken(tokens.value.length - 1)
  }
}

const SIGN_TITLE: Record<LabelSign, string> = {
  '+': 'Añadir — clic para cambiar',
  '-': 'Quitar — clic para cambiar',
  '=': 'Reemplazar por — clic para cambiar',
}
</script>

<template>
  <div class="loe">
    <span v-for="(t, i) in tokens" :key="`${t.label}-${i}`" class="loe-chip" :data-sign="t.sign">
      <button
        type="button"
        class="loe-sign"
        :title="SIGN_TITLE[t.sign]"
        @click="cycleSign(i)"
      >{{ t.sign }}</button>
      <span class="loe-name">{{ t.label }}</span>
      <button
        type="button"
        class="loe-x"
        :aria-label="`Quitar ${t.label}`"
        @click="removeToken(i)"
      >✕</button>
    </span>

    <input
      v-model="draft"
      class="loe-input"
      :list="listId"
      placeholder="label"
      @keydown="onKeydown"
      @blur="commitDraft"
    />
    <datalist :id="listId">
      <option v-for="o in suggestions" :key="o" :value="o" />
    </datalist>
  </div>
</template>

<style scoped>
.loe {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  flex: 1 1 0;
  min-width: 0;
  min-height: var(--row-h);
  padding: 0 0.3ch;
  border: 1px solid var(--border);
  background: var(--panel);
}

.loe-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.2ch;
  height: calc(var(--row-h) - 4px);
  padding: 0 0.2ch;
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.loe-chip[data-sign='+'] { border-color: var(--accent); }
.loe-chip[data-sign='-'] { border-color: var(--danger); }
.loe-chip[data-sign='='] { border-color: var(--warn); }

.loe-sign {
  border: none;
  background: none;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 0 0.2ch;
}
.loe-chip[data-sign='+'] .loe-sign { color: var(--accent); }
.loe-chip[data-sign='-'] .loe-sign { color: var(--danger); }
.loe-chip[data-sign='='] .loe-sign { color: var(--warn); }

.loe-name { color: var(--fg); }

.loe-x {
  border: none;
  background: none;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: var(--fs-micro);
  padding: 0 0.2ch;
}
.loe-x:hover { color: var(--danger); }

.loe-input {
  flex: 1 1 4rem;
  min-width: 4rem;
  height: calc(var(--row-h) - 4px);
  border: none;
  background: none;
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  outline: none;
}
</style>
