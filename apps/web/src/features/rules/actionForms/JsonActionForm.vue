<script setup lang="ts">
import type { ActionFormEmits, ActionFormProps } from '@/features/rules/actionForms/types'
import JsonField from '@/features/rules/actionForms/JsonField.vue'

// El fallback para un tipo de acción sin form dedicado.
//
// La lista de tipos la publica el daemon (`GET /api/rules/action-kinds`), así
// que un handler nuevo aparece en el editor sin esperar un release de la web.
// Editarlo como JSON crudo es peor que un form, y muchísimo mejor que un
// desplegable con una opción que no se puede completar.

const props = defineProps<ActionFormProps>()
const emit = defineEmits<ActionFormEmits>()

/** `action` queda afuera: es el discriminante y lo cambia el selector de tipo
 *  de arriba. Editarlo acá dejaría el form mostrando un tipo y guardando otro. */
function config(): Record<string, unknown> {
  const { action: _action, continueOnError: _c, ...rest } = props.entry
  return rest
}

function setConfig(v: unknown) {
  const next = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>
  // Borra lo que se sacó del JSON: un patch sólo mergea, así que sin los
  // `undefined` explícitos un campo eliminado seguiría en la acción.
  const cleared = Object.fromEntries(Object.keys(config()).map((k) => [k, undefined]))
  emit('patch', { ...cleared, ...next })
}
</script>

<template>
  <div class="ff-row">
    <span class="uc-label">Config (JSON)</span>
    <JsonField :model-value="config()" :rows="6" @update:model-value="setConfig" />
    <span class="ff-hint">
      Este tipo de acción no tiene un formulario dedicado en esta versión de la web.
      El server lo valida con el schema propio de la acción.
    </span>
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>
