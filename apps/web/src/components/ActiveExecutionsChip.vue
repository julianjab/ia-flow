<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { formatRelative } from '@/features/executions/relativeTime';

const store = useActiveExecutionsStore();
const router = useRouter();

const open = ref(false);
const chipRoot = ref<HTMLElement | null>(null);

function toggle() { open.value = !open.value; }

function onDocClick(e: MouseEvent) {
  if (!open.value) return;
  if (chipRoot.value && !chipRoot.value.contains(e.target as Node)) {
    open.value = false;
  }
}
onMounted(() => document.addEventListener('mousedown', onDocClick));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick));

function goExecution(projectId: string) {
  open.value = false;
  void router.push(`/projects/${projectId}/executions`);
}
</script>

<template>
  <div ref="chipRoot" class="chip-root">
    <button
      type="button"
      class="chip"
      :class="{ 'chip--live': store.activeCount > 0 }"
      :aria-expanded="open"
      :title="`${store.activeCount} ejecución${store.activeCount === 1 ? '' : 'es'} en curso`"
      @click="toggle"
    >
      <span class="chip__glyph">{{ store.activeCount > 0 ? '●' : '○' }}</span>
      <span class="chip__count">{{ store.activeCount }}</span>
      <span class="chip__label">corriendo</span>
    </button>

    <div v-if="open" class="popover" role="dialog" aria-label="Ejecuciones activas">
      <div class="popover__header">EJECUCIONES ACTIVAS</div>
      <ul v-if="store.executions.length" class="popover__list">
        <li
          v-for="e in store.executions"
          :key="e.id"
          class="popover__item"
          @click="goExecution(e.projectId)"
        >
          <span class="popover__glyph">◐</span>
          <span class="popover__title">{{ e.taskTitle || e.taskId }}</span>
          <span class="popover__code">{{ e.projectId }}</span>
          <span class="popover__meta">{{ formatRelative(e.startedAt) }}</span>
        </li>
      </ul>
      <div v-else class="popover__empty">· nada en curso</div>
    </div>
  </div>
</template>

<style scoped>
.chip-root { position: relative; }

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  height: 20px;
  padding: 0 0.75rem;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-dim);
  font: 500 var(--fs-chrome)/1 var(--font-mono);
  cursor: pointer;
}
.chip:hover { border-color: var(--border-hi); color: var(--fg); }
.chip--live {
  color: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 12px -6px var(--accent);
}

.chip__glyph { color: var(--accent); }
.chip--live .chip__glyph { animation: blink 1.6s ease-in-out infinite; }
.chip__count { color: var(--fg); font-weight: 700; }
.chip__label { color: inherit; }

.popover {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  min-width: 380px;
  max-width: 520px;
  background: var(--panel);
  border: 1px solid var(--border);
  z-index: 100;
  overflow: hidden;
  font-family: var(--font-mono);
}
.popover__header {
  padding: 0.35rem 0.75rem;
  background: var(--panel-hi);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-chrome);
  letter-spacing: var(--tracking-hd);
  color: var(--fg);
}
.popover__list { list-style: none; margin: 0; padding: 0; max-height: 360px; overflow: auto; }
.popover__item {
  display: grid;
  grid-template-columns: 3ch 1fr auto auto;
  gap: 0.75rem;
  align-items: center;
  padding: 0 0.75rem;
  height: 20px;
  font-size: var(--fs-body-sm);
  color: var(--fg-dim);
  cursor: pointer;
  border-bottom: 1px solid var(--border-mute);
}
.popover__item:hover { background: var(--panel-hi); color: var(--fg); }
.popover__glyph { color: var(--warn); }
.popover__title {
  color: var(--fg);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.popover__code { color: var(--cyan); font-size: var(--fs-chrome); }
.popover__meta { color: var(--fg-dimmer); font-size: var(--fs-chrome); }

.popover__empty {
  padding: 0.75rem;
  color: var(--fg-dimmer);
  font-size: var(--fs-body-sm);
}
</style>
