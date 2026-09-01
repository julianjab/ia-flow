<script setup lang="ts">
import type { AgentOutput, AgentOutputField } from '@ia-flow/shared'
import { ref, watch } from 'vue'

// `AgentDefinition.output` — el contrato de salida estructurada de un agente.
//
// Declararlo hace tres cosas: le ofrece al agente la tool `submit_output` con
// este schema exacto, vuelve OBLIGATORIO llamarla antes de cerrar, y publica el
// payload para que una regla se lo pase al paso siguiente
// (`{{steps.<paso>.output.<campo>}}`).

const props = defineProps<{ modelValue?: AgentOutput }>()
const emit = defineEmits<{ 'update:modelValue': [AgentOutput | undefined] }>()

type Row = { name: string; type: AgentOutputField['type']; description: string; enum: string; optional: boolean }

/**
 * Filas como estado LOCAL, no derivadas del modelo.
 *
 * Una fila recién agregada no tiene nombre y no se puede guardar (ver `push`);
 * si el DOM se derivara del valor guardado, esa fila desaparecería apenas se
 * escribe y no habría forma de crear la primera.
 */
const rows = ref<Row[]>(toRows(props.modelValue))

function toRows(value: AgentOutput | undefined): Row[] {
  return Object.entries(value ?? {}).map(([name, f]) => ({
    name,
    type: f.type ?? 'string',
    description: f.description ?? '',
    enum: (f.enum ?? []).join(', '),
    optional: f.optional ?? false,
  }))
}

// Re-sembrar cuando el modal cambia de agente. Se compara contra lo que las
// filas producen para no pisar lo que el operador está escribiendo con el eco
// de su propio `update:modelValue`.
watch(
  () => props.modelValue,
  (v) => {
    if (JSON.stringify(v ?? {}) !== JSON.stringify(build() ?? {})) rows.value = toRows(v)
  },
)

/** Sólo las filas completas: un campo sin nombre no es un campo. Sin ninguna
 *  se emite `undefined` y no `{}` — un contrato vacío haría que el agente
 *  tuviera que llamar a `submit_output` sin nada que entregar. */
function build(): AgentOutput | undefined {
  const out: AgentOutput = {}
  for (const r of rows.value) {
    const name = r.name.trim()
    if (!name) continue
    const values = r.enum
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
    out[name] = {
      type: r.type,
      ...(r.description.trim() ? { description: r.description.trim() } : {}),
      ...(values.length ? { enum: values } : {}),
      ...(r.optional ? { optional: true } : {}),
    }
  }
  return Object.keys(out).length ? out : undefined
}

function sync() {
  emit('update:modelValue', build())
}

function add() {
  rows.value.push({ name: '', type: 'string', description: '', enum: '', optional: false })
}

function remove(i: number) {
  rows.value.splice(i, 1)
  sync()
}
</script>

<template>
  <div class="oce">
    <span class="field-hint">
      Los campos que este agente entrega con <code>submit_output</code> para que otro paso
      de la regla los lea. Declararlo lo vuelve <strong>obligatorio</strong>: si el agente
      cierra sin entregarlos, el run falla — un contrato que se puede incumplir en silencio
      deja al paso siguiente trabajando con un encargo mutilado.
    </span>

    <div v-for="(row, i) in rows" :key="i" class="oce__row">
      <input
        v-model="row.name"
        class="oce__name"
        placeholder="brief"
        aria-label="Nombre del campo"
        @input="sync()"
      />
      <select v-model="row.type" class="oce__type" aria-label="Tipo" @change="sync()">
        <option value="string">string</option>
        <option value="number">number</option>
        <option value="boolean">boolean</option>
      </select>
      <input
        v-model="row.description"
        class="oce__desc"
        placeholder="qué tiene que poner el agente ahí"
        aria-label="Descripción"
        @input="sync()"
      />
      <input
        v-model="row.enum"
        class="oce__enum"
        placeholder="valores, separados, por coma"
        aria-label="Valores permitidos"
        @input="sync()"
      />
      <label class="oce__opt" title="Opcional">
        <input v-model="row.optional" type="checkbox" @change="sync()" />
        <span>opc.</span>
      </label>
      <button type="button" class="oce__btn" title="Quitar" @click="remove(i)">✕</button>
    </div>

    <button type="button" class="oce__btn oce__add" @click="add()">+ campo</button>

    <span v-if="!rows.length" class="field-hint">
      Sin campos declarados el agente cierra con prosa, como siempre, y sigue siendo
      encadenable por texto (<code>{{ '\{\{steps.X.output\}\}' }}</code>).
    </span>
  </div>
</template>

<style scoped>
.oce {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.oce__row {
  display: flex;
  align-items: center;
  gap: 0.5ch;
}
.oce__name {
  flex: 0 0 14ch;
}
.oce__type {
  flex: 0 0 10ch;
}
.oce__desc {
  flex: 1 1 auto;
  min-width: 12ch;
}
.oce__enum {
  flex: 0 0 22ch;
}
.oce__opt {
  display: flex;
  align-items: center;
  gap: 0.25ch;
  color: var(--fg-dim);
  flex: 0 0 auto;
}
.oce__btn {
  background: none;
  border: none;
  color: var(--fg-dim);
  cursor: pointer;
  font: inherit;
  height: var(--row-h);
  padding: 0 0.5ch;
}
.oce__btn:hover {
  color: var(--fg);
}
.oce__add {
  align-self: flex-start;
}
</style>
