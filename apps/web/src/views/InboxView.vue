<script setup lang="ts">
import ImprovementsLink from '@/features/improvements/ImprovementsLink.vue';
import MineBoard from '@/features/inbox/MineBoard.vue';

// «Para mí»: lo que te necesita y, al pie, una fila con las mejoras que esperan (su pantalla es
// «Mejoras»). Son dos features y ninguna importa a la otra.
</script>

<template>
  <div class="inbox-view">
    <MineBoard />
    <ImprovementsLink />
  </div>
</template>

<style scoped>
.inbox-view { display: flex; flex-direction: column; gap: 1rem; }
</style>
