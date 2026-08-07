<script setup lang="ts">
const VARIABLES = [
  'task_title',
  'task_description',
  'task_type',
  'repos',
  'response_language',
] as const;

function onDragStart(name: string, event: DragEvent): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData('text/plain', `{${name}}`);
  event.dataTransfer.effectAllowed = 'copy';
}
</script>

<template>
  <aside class="variable-chips-panel" data-testid="variable-chips-panel">
    <h3 class="panel-title">Variables</h3>
    <p class="panel-hint">Arrastra un chip sobre un bloque para insertar el placeholder.</p>
    <ul class="chip-list">
      <li
        v-for="name in VARIABLES"
        :key="name"
        class="chip"
        draggable="true"
        :data-testid="`variable-chip-${name}`"
        @dragstart="onDragStart(name, $event)"
      >
        {{ '{' + name + '}' }}
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.variable-chips-panel {
  width: 220px;
  flex-shrink: 0;
  border-left: 1px solid #e5e7eb;
  padding-left: 1rem;
}
.panel-title {
  margin: 0 0 0.25rem 0;
  font-size: 0.875rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #374151;
}
.panel-hint {
  margin: 0 0 0.75rem 0;
  font-size: 0.75rem;
  color: #6b7280;
}
.chip-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.chip {
  cursor: grab;
  padding: 0.35rem 0.5rem;
  background: #eef2ff;
  color: #3730a3;
  border: 1px solid #c7d2fe;
  border-radius: 999px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8125rem;
  text-align: center;
  user-select: none;
}
.chip:active {
  cursor: grabbing;
}
</style>
