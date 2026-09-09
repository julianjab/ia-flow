<script setup lang="ts">
import type { TaskChatAction } from '@ia-flow/shared';

/**
 * Las acciones que un mensaje del asistente propone, en estado STAGED.
 *
 * Nada acá muta nada: los chips son de sólo lectura y la barra de abajo es lo
 * único que dispara algo, y sólo cuando el operador la toca. `resolved` lo
 * decide el padre (`TaskChatDrawer`) — una vez aplicadas o descartadas, este
 * bloque desaparece del historial en vez de quedar ahí ofreciendo un botón
 * que ya actuó.
 */
defineProps<{
  actions: TaskChatAction[];
}>();

defineEmits<{
  apply: [];
  discard: [];
}>();
</script>

<template>
  <div class="task-action-block">
    <ul class="chip-list">
      <li v-for="(action, i) in actions" :key="i" class="action-chip">
        <span class="chip-item">{{ action.itemTitle ?? action.itemId }}</span>
        <span class="chip-sep">·</span>
        <span class="chip-field">{{ action.field }}</span>
        <span class="chip-arrow">→</span>
        <span class="chip-value">{{ action.value }}</span>
      </li>
    </ul>
    <div class="action-bar">
      <button type="button" class="btn btn--primary" data-testid="chat-apply" @click="$emit('apply')">
        Aplicar
      </button>
      <button type="button" class="btn btn--ghost" data-testid="chat-discard" @click="$emit('discard')">
        Descartar
      </button>
    </div>
  </div>
</template>

<style scoped>
.task-action-block {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  background: var(--panel-alt);
}
.chip-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.action-chip {
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg);
}
.chip-item { font-weight: 700; }
.chip-sep,
.chip-arrow { color: var(--fg-dimmer); }
.chip-field { color: var(--fg-dim); }
.chip-value { color: var(--accent); }
.action-bar { display: flex; gap: 0.5rem; }
.action-bar .btn { height: var(--tap-h-sm); padding: 0 0.75rem; font-size: var(--fs-micro); }
</style>
