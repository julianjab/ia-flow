<script setup lang="ts">
import ImprovementsSection from '@/features/improvements/ImprovementsSection.vue';
import InboxBoard from '@/features/inbox/InboxBoard.vue';
import { useTaskFocusStore } from '@/stores/taskFocus';

// Composición: la bandeja y, debajo, las mejoras que propuso un agente. Son dos features y
// ninguna importa a la otra: la ref de una tarea se pide a la bandeja por `taskFocus`.
const taskFocus = useTaskFocusStore();
</script>

<template>
  <div class="inbox-view">
    <InboxBoard />
    <ImprovementsSection @open="taskFocus.focus($event)" />
  </div>
</template>

<style scoped>
.inbox-view { display: flex; flex-direction: column; gap: 1rem; }
</style>
