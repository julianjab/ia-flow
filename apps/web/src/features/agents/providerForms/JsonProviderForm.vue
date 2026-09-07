<script setup lang="ts">
import JsonConfigField from '@/ui/JsonConfigField.vue';

// Fallback para los provider ids sin componente dedicado: el config se edita
// como JSON crudo, así que un provider registrado server-side queda editable
// sin publicar una versión de la web.
//
// La caja es `ui/JsonConfigField.vue` — la misma que usa el fallback de source.
defineProps<{ modelValue: Record<string, unknown> }>();
defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>();
</script>

<template>
  <JsonConfigField
    :model-value="modelValue"
    hint="Este provider no tiene un formulario dedicado. Escribí el config crudo acá; el server lo valida con el schema propio del provider."
    @update:model-value="(v) => $emit('update:modelValue', v)"
  />
</template>
