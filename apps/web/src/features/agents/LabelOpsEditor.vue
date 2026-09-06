<script setup lang="ts">
// Valor de la fila `Labels` dentro de los outcomes: chips con signo, donde el
// signo ES la operación. `+design` añade, `-design` quita. El signo viaja
// pegado a cada label en vez de haber listas separadas por acción, porque es
// como se piensa la operación ("agregá design, sacá wip") y es exactamente el
// formato que después viaja en el string `$labels:`.
//
// `=` (reemplazar por) es el tercer estado del mismo toggle: casi nunca se
// usa, pero sin él una config guardada con `=` quedaría imposible de editar.
//
// Los chips y el input viven DENTRO del mismo `ComboBox` (modo `multiple`) —
// no en una caja propia al lado — para que se vea como cualquier otro picker
// de chips de la app (el de reviewers de Slack, p. ej.), en vez de un widget
// aparte con su propio borde. El signo es lo único que ComboBox no sabe
// dibujar: se inyecta en el slot `chip-extra`, pensado justo para que un
// dominio agregue su propia acción sin que el componente se entere de qué es.
import { computed } from 'vue'
import {
  type LabelSign,
  type LabelToken,
  parseLabelTokens,
  serializeLabelTokens,
} from '@/features/agents/outcomes-serialization'
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue'

const props = defineProps<{
  /** Tokens serializados, ej. `"+design,-wip"`. */
  modelValue: string
  /** Catálogo de labels conocidas para sugerir. Puede venir vacío. */
  options?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const tokens = computed<LabelToken[]>(() => parseLabelTokens(props.modelValue))

/** Lo que ComboBox necesita para pintar los chips: sólo el label, sin signo —
 *  el signo es un dato nuestro que el componente no conoce. */
const selectedLabels = computed(() => tokens.value.map((t) => t.label))

const catalogOptions = computed<ComboOption[]>(() => (props.options ?? []).map((o) => ({ value: o })))

function emitTokens(next: LabelToken[]) {
  emit('update:modelValue', serializeLabelTokens(next))
}

function signOf(label: string): LabelSign {
  return tokens.value.find((t) => t.label.toLowerCase() === label.toLowerCase())?.sign ?? '+'
}

const NEXT_SIGN: Record<LabelSign, LabelSign> = { '+': '-', '-': '=', '=': '+' }

function cycleSign(label: string) {
  emitTokens(
    tokens.value.map((t) =>
      t.label.toLowerCase() === label.toLowerCase() ? { ...t, sign: NEXT_SIGN[t.sign] } : t,
    ),
  )
}

/** ComboBox devuelve el array COMPLETO de valores elegidos — agregar, quitar
 *  y Backspace-borra-el-último llegan todos por acá como una sola lista
 *  nueva. Lo que agrega puede traer signo (`-wip`, tipeado a mano) o varias
 *  labels de una (`design, wip`, pegadas): por eso lo nuevo pasa por
 *  `parseLabelTokens`, el mismo parser que entiende el DSL, en vez de tomarse
 *  tal cual como un label literal. */
function onSelectionChange(next: string[]) {
  const before = new Set(tokens.value.map((t) => t.label.toLowerCase()))
  const after = new Set(next.map((l) => l.toLowerCase()))

  const kept = tokens.value.filter((t) => after.has(t.label.toLowerCase()))
  const addedRaw = next.filter((l) => !before.has(l.toLowerCase()))
  const addedTokens = addedRaw.flatMap((raw) => parseLabelTokens(raw))

  const keptLower = new Set(kept.map((t) => t.label.toLowerCase()))
  const fresh = addedTokens.filter((t) => !keptLower.has(t.label.toLowerCase()))

  emitTokens([...kept, ...fresh])
}

const SIGN_TITLE: Record<LabelSign, string> = {
  '+': 'Añadir — clic para cambiar',
  '-': 'Quitar — clic para cambiar',
  '=': 'Reemplazar por — clic para cambiar',
}

// Nombres de clase legibles, no el signo crudo: `+`/`=` no son caracteres
// válidos en un selector CSS sin escapar.
const SIGN_CLASS: Record<LabelSign, string> = {
  '+': 'loe-sign--add',
  '-': 'loe-sign--remove',
  '=': 'loe-sign--replace',
}
</script>

<template>
  <ComboBox
    class="loe-combo"
    multiple
    :model-value="selectedLabels"
    :options="catalogOptions"
    allow-custom
    placeholder="label"
    @update:model-value="onSelectionChange($event as string[])"
  >
    <template #chip-extra="{ value }">
      <button
        type="button"
        class="loe-sign"
        :class="SIGN_CLASS[signOf(value)]"
        :title="SIGN_TITLE[signOf(value)]"
        @click.stop="cycleSign(value)"
      >{{ signOf(value) }}</button>
    </template>
  </ComboBox>
</template>

<style scoped>
.loe-combo {
  flex: 1 1 0;
  min-width: 0;
}

.loe-sign {
  border: none;
  background: none;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  font-weight: 700;
  line-height: 1;
  padding: 0 0.2ch;
}
.loe-sign--add { color: var(--accent); }
.loe-sign--remove { color: var(--danger); }
.loe-sign--replace { color: var(--warn); }
</style>
