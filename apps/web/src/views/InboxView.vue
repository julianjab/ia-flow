<script setup lang="ts">
import ImprovementsSection from '@/features/improvements/ImprovementsSection.vue';
import MineBoard from '@/features/inbox/MineBoard.vue';
import { useTaskFocusStore } from '@/stores/taskFocus';

// «Para mí»: lo que te necesita y, debajo, las mejoras que propuso un agente (también te esperan).
// Son dos features y ninguna importa a la otra: la ref de una tarea se pide por `taskFocus`.
const taskFocus = useTaskFocusStore();
</script>

<template>
  <div class="inbox-view">
    <MineBoard />
    <ImprovementsSection @open="taskFocus.focus($event)" />
  </div>
</template>

<style scoped>
.inbox-view { display: flex; flex-direction: column; gap: 1rem; }
</style>
