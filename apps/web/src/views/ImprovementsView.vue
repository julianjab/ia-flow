<script setup lang="ts">
import ImprovementsSection from '@/features/improvements/ImprovementsSection.vue';
import { useTaskFocusStore } from '@/stores/taskFocus';

// «Mejoras»: lo que dejó la retrospectiva, para abrir como issue o descartar. Las mismas que van al
// pie de «Para mí», solas: desde el menú lateral o el sheet «Más».
const taskFocus = useTaskFocusStore();
</script>

<template>
  <div class="view">
    <h1 class="view__title">Mejoras</h1>
    <ImprovementsSection @open="taskFocus.focus($event)" />
  </div>
</template>

<style scoped>
.view { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
.view__title { margin: 0; font-size: var(--fs-display); }
</style>
