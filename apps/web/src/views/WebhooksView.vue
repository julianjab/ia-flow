<script setup lang="ts">
import IngressPanel from '@/features/ingress/IngressPanel.vue';
</script>

<template>
  <div class="view">
    <h1 class="view__title">Webhooks</h1>
    <IngressPanel />
  </div>
</template>

<style scoped>
/* El título de la pantalla, como «Bandeja»: display, en minúscula normal (R9: la barra dice la app, esto la pantalla). */
.view { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
.view__title { margin: 0; font-size: var(--fs-display); }
</style>
