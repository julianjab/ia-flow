<script setup lang="ts">
// The local source has no config today; the form exists so SourceFormSwitch
// can render something informative and so future knobs (e.g. filesystem
// path override) fit without shape changes.
defineProps<{ modelValue: Record<string, unknown> }>();
defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>();
</script>

<template>
  <p class="lsf-msg">
    Los items se leen desde archivos locales — no requiere configuración adicional.
  </p>
</template>

<style scoped>
.lsf-msg {
  margin: 0;
  padding: 0.75rem 1rem;
  background: #f9fafb;
  border: 1px dashed #d1d5db;
  border-radius: 6px;
  color: #6b7280;
  font-size: 0.85rem;
}
</style>
