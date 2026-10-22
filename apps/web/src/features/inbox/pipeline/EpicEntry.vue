<script setup lang="ts">
import type { EpicLine } from '@/features/inbox/queue/epics';
import { useInboxStore } from '@/features/inbox/store';

// Una épica en «Dónde se traba cada épica»: su nombre (abre la épica con sus sub-issues),
// done/total, la barra de avance (decorativa: el número ya lo dice) y la decisión tuya que la
// frena, en --warn.

defineProps<{ epic: EpicLine }>();

const store = useInboxStore();
</script>

<template>
  <li class="ee">
    <div class="ee__top">
      <button v-if="epic.url" type="button" class="ee__name ee__open link" :title="epic.title" data-test="epic-open" @click="store.openEpic(epic.ref)"
        ><span class="ee__text">{{ epic.title }}</span></button
      >
      <span v-else class="ee__name" :title="epic.title"><span class="ee__text">{{ epic.title }}</span></span>
      <span class="ee__count mono">{{ epic.done }}/{{ epic.total }}</span>
    </div>
    <div class="ee__bar" aria-hidden="true"><div class="ee__fill" :style="{ width: `${epic.pct}%` }" /></div>
    <p class="ee__neck" data-test="epic-neck">{{ epic.neck }}</p>
  </li>
</template>

<style scoped>
.ee { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.55rem 0; border-top: 1px solid var(--border-mute); }
.ee__top { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; min-width: 0; }
/* Dos líneas como máximo (el `title` lleva el resto): un título de 5 líneas empujaba la cuenta al
   medio. El blanco táctil es el padding del link; el recorte va en el texto de adentro, porque
   `overflow: hidden` no recorta el padding y la tercera línea asomaba por ahí. */
.ee__name { display: block; min-width: 0; padding-block: 0.6rem; font-weight: 500; line-height: 1.35; }
.ee__text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
span.ee__name { color: var(--fg); }
.ee__open { border: none; background: none; font: inherit; font-weight: 500; text-align: left; cursor: pointer; }
.ee__count { flex: none; padding-top: 0.6rem; color: var(--fg-dim); font-size: var(--fs-chrome); line-height: 1.35rem; font-variant-numeric: tabular-nums; }
.ee__bar { height: 0.3rem; overflow: hidden; border-radius: var(--radius-sm); background: var(--panel-hi); }
.ee__fill { height: 100%; background: var(--accent); }
.ee__neck { margin: 0; color: var(--warn); font-size: var(--fs-chrome); line-height: 1.45; }
</style>
