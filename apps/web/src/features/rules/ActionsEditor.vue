<script setup lang="ts">
import type { RuleActionEntry } from '@ia-flow/shared'
import { computed } from 'vue'
import ActionFields from '@/features/rules/ActionFields.vue'
import {
  actionLabelFor,
  blankActionFor,
} from '@/features/rules/actionForms/registry'
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue'

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
  /** Las acciones con nombre del ámbito, para el campo `ref`. */
  actionIds?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: RuleActionEntry[]): void
}>()

type Entry = Record<string, unknown> & { action: string; continueOnError?: boolean }

const entries = computed<Entry[]>(() => props.modelValue as unknown as Entry[])

// `ComboBox` y no un `<select>`: el desplegable de un select lo dibuja el
// sistema operativo —fondo blanco y highlight azul sobre una consola oscura— y
// no hay CSS que lo tematice. Es el mismo control que ya usan los campos de
// adentro de la acción. Sin `allow-custom`: un tipo que el daemon no sabe
// ejecutar fallaría recién en el primer evento.
const kindOptions = computed<ComboOption[]>(() =>
  props.availableKinds.map((value) => ({ value, label: actionLabelFor(value), hint: value })),
)

/** Los blancos viven en el registry, al lado del form que los edita: agregar un
 *  tipo de acción es una entrada allá, no un `if` más acá. */
function blankFor(kind: string): Entry {
  return blankActionFor(kind, { agentId: props.agentIds?.[0] }) as Entry
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

/** Cambiar el tipo REEMPLAZA la entrada (ver `blankActionFor`), salvo
 *  `continueOnError`: vive fuera del union y significa lo mismo en todos. */
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

</script>

<template>
  <div class="ae">
    <div v-for="(entry, i) in entries" :key="i" class="ae-card">
      <div class="ae-head">
        <span class="ae-idx">{{ i + 1 }}</span>
        <ComboBox
          class="ae-kind"
          :model-value="entry.action"
          :options="kindOptions"
          :placeholder="actionLabelFor(entry.action)"
          empty-text="Ningún tipo coincide"
          @update:model-value="(v) => changeKind(i, Array.isArray(v) ? (v[0] ?? '') : v)"
        />
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
        <ActionFields
          :entry="entry"
          :agent-ids="agentIds"
          :action-ids="actionIds"
          @patch="(changes) => patch(i, changes)"
        />

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

.ae-kind { flex: 0 1 14rem; min-width: 0; }
.ae-spacer { flex: 1 1 auto; }

.ae-body {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.6rem;
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
