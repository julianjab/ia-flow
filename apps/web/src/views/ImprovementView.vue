<script setup lang="ts">
import ImprovementDetail from '@/features/improvements/ImprovementDetail.vue';
import { useTaskFocusStore } from '@/stores/taskFocus';

// Una mejora en su pantalla, con la ruta de vuelta a «Mejoras». Ir a la tarea de origen la abre en
// la bandeja (`taskFocus`).
defineProps<{ id: string }>();
const taskFocus = useTaskFocusStore();
</script>

<template>
  <ImprovementDetail :id="id" @open="taskFocus.focus($event)" />
</template>
