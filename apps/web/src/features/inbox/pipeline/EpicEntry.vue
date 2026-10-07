<script setup lang="ts">
import type { EpicLine } from '@/features/inbox/queue/epics';

// Una épica en «Dónde se traba cada épica»: su nombre (link al issue), done/total, la barra de
// avance (decorativa: el número ya lo dice) y la decisión tuya que la frena, en --warn.

defineProps<{ epic: EpicLine }>();
</script>

<template>
  <li class="ee">
    <div class="ee__top">
      <a v-if="epic.url" class="ee__name" :href="epic.url" target="_blank" rel="noopener">{{ epic.title }}</a>
      <span v-else class="ee__name">{{ epic.title }}</span>
      <span class="ee__count mono">{{ epic.done }}/{{ epic.total }}</span>
    </div>
    <div class="ee__bar" aria-hidden="true"><div class="ee__fill" :style="{ width: `${epic.pct}%` }" /></div>
    <p class="ee__neck" data-test="epic-neck">{{ epic.neck }}</p>
  </li>
</template>

<style scoped>
.ee { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.55rem 0; border-top: 1px solid var(--border-mute); }
.ee__top { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; min-width: 0; }
.ee__name { display: inline-flex; align-items: center; min-height: var(--tap-h); min-width: 0; color: var(--fg); font-weight: 500; overflow-wrap: anywhere; }
.ee__name:hover { color: var(--accent); }
.ee__name:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
.ee__count { flex: none; color: var(--fg-dim); font-size: var(--fs-chrome); font-variant-numeric: tabular-nums; }
.ee__bar { height: 0.3rem; overflow: hidden; border-radius: var(--radius-sm); background: var(--panel-hi); }
.ee__fill { height: 100%; background: var(--accent); }
.ee__neck { margin: 0; color: var(--warn); font-size: var(--fs-chrome); line-height: 1.45; }
</style>
