<script setup lang="ts">
import ImprovementsSection from '@/features/improvements/ImprovementsSection.vue';

// «Mejoras»: lo que dejó la retrospectiva, una fila por mejora; cada una lleva a su pantalla para
// abrirla como issue, descartarla o preguntar por qué. Desde el menú lateral, «Más» o la fila del
// pie de «Para mí».
</script>

<template>
  <div class="view">
    <h1 class="view__title">Mejoras</h1>
    <ImprovementsSection />
  </div>
</template>

<style scoped>
.view { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
.view__title { margin: 0; font-size: var(--fs-display); }
</style>
