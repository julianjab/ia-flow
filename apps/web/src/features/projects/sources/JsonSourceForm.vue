<script setup lang="ts">
import JsonConfigField from '@/ui/JsonConfigField.vue';

// Fallback para los source kinds sin componente dedicado: el config se edita
// como JSON crudo, así que un source nuevo registrado en el server es usable
// desde la UI sin publicar una versión de la web.
//
// La caja es `ui/JsonConfigField.vue` — la misma que usa el fallback de
// provider. Eran dos copias idénticas con dos prefijos distintos.
defineProps<{ modelValue: Record<string, unknown> }>();
defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>();
</script>

<template>
  <JsonConfigField
    :model-value="modelValue"
    hint="Este kind de source no tiene un formulario dedicado. El server valida el config con el schema propio del source."
    @update:model-value="(v) => $emit('update:modelValue', v)"
  />
</template>
