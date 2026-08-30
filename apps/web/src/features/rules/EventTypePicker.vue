<script setup lang="ts">
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue'
import { EVENT_CATALOG } from '@ia-flow/shared'
import { computed } from 'vue'

// Los tipos de evento de una regla, sobre el ComboBox del design system: varios
// valores, con chips, aceptando los que no están en el catálogo.
//
// **No es un desplegable cerrado, y no puede serlo.** El bus no valida el tipo
// contra el catálogo: un `emit` con un tipo propio del operador, o un evento de
// un agent-host de otra versión, son configuraciones legítimas. Cerrar la lista
// las volvería imposibles de escribir.
//
// Lo que sí faltaba era saber QUÉ HAY. La descripción es la mitad del valor —
// `pr.synchronize` no le dice nada a nadie hasta que se lee "llegaron commits
// nuevos a un pull request abierto".
//
// El modelo sigue siendo el string separado por comas que la regla persiste:
// convertirlo acá es una línea, y cambiar el schema movería el problema a la
// API y al YAML de los deploys.

const model = defineModel<string>({ required: true })

const types = computed(() =>
  model.value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
)

const options = computed<ComboOption[]>(() =>
  EVENT_CATALOG.map((e) => ({
    value: e.type,
    hint: `${e.source} · ${e.description}`,
    glyph: '◆',
  })),
)

function onUpdate(next: string | string[]) {
  model.value = (Array.isArray(next) ? next : [next]).join(', ')
}
</script>

<template>
  <ComboBox
    multiple
    allow-custom
    :model-value="types"
    :options="options"
    placeholder="pr.opened, pr.synchronize"
    empty-text="Ninguno conocido coincide — el valor que escribas se guarda igual."
    @update:model-value="onUpdate"
  />
</template>
