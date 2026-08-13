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
      :class="{ 'chip--active': store.activeCount > 0 }"
      :aria-expanded="open"
      :title="`${store.activeCount} ejecucion${store.activeCount === 1 ? '' : 'es'} en curso`"
      @click="toggle"
    >
      <span class="chip__dot" :class="{ 'chip__dot--live': store.activeCount > 0 }" />
      <span class="chip__count">{{ store.activeCount }}</span>
      <span class="chip__label">corriendo</span>
    </button>

    <div v-if="open" class="popover" role="dialog" aria-label="Ejecuciones activas">
      <header class="popover__header">Ejecuciones activas</header>
      <ul v-if="store.executions.length" class="popover__list">
        <li
          v-for="e in store.executions"
          :key="e.id"
          class="popover__item"
          @click="goExecution(e.projectId)"
        >
          <span class="chip__dot chip__dot--live" />
          <span class="popover__title">{{ e.taskTitle || e.taskId }}</span>
          <code class="popover__code">{{ e.projectId }}</code>
          <span class="popover__meta">{{ formatRelative(e.startedAt) }}</span>
        </li>
      </ul>
      <div v-else class="popover__empty">Nada en curso.</div>
    </div>
  </div>
</template>

<style scoped>
.chip-root { position: relative; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.65rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  color: #374151;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
}
.chip:hover { background: #f9fafb; }
.chip--active {
  background: #ecfdf5;
  color: #065f46;
  border-color: #a7f3d0;
}
.chip__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #9ca3af;
}
.chip__dot--live {
  background: #22c55e;
  box-shadow: 0 0 0 0 rgba(34,197,94,0.6);
  animation: chip-pulse 1.6s ease-out infinite;
}
@keyframes chip-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.6); }
  70%  { box-shadow: 0 0 0 6px rgba(34,197,94,0); }
  100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
}
.chip__count { font-weight: 700; }
.chip__label { color: inherit; }

.popover {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  min-width: 320px;
  max-width: 420px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.08);
  z-index: 100;
  overflow: hidden;
}
.popover__header {
  padding: 0.5rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: #6b7280;
  border-bottom: 1px solid #f3f4f6;
}
.popover__list { list-style: none; margin: 0; padding: 0.25rem 0; max-height: 320px; overflow: auto; }
.popover__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 0.75rem;
  font-size: 0.85rem;
  cursor: pointer;
}
.popover__item:hover { background: #f9fafb; }
.popover__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.popover__code {
  background: #f3f4f6;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  font-size: 0.7rem;
  color: #374151;
}
.popover__meta { color: #6b7280; font-size: 0.75rem; white-space: nowrap; }
.popover__empty { padding: 1rem; text-align: center; color: #9ca3af; font-size: 0.85rem; }
</style>
