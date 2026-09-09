<script setup lang="ts">
import type { TaskChatAction } from '@ia-flow/shared';
import TaskActionBlock from '@/features/tasks/TaskActionBlock.vue';

/**
 * Una burbuja del historial. `resolved` es estado del padre —no del mensaje
 * en sí—, porque "aplicado/descartado" es una decisión tomada DESPUÉS de que
 * el mensaje llegó, y guardarla en `TaskChatMessage` (el contrato de red)
 * mezclaría historial con estado de UI.
 */
defineProps<{
  role: 'user' | 'assistant';
  content: string;
  actions?: TaskChatAction[];
  resolved?: boolean;
}>();

defineEmits<{
  apply: [];
  discard: [];
}>();
</script>

<template>
  <div class="chat-bubble" :class="`is-${role}`">
    <span class="bubble-role">{{ role === 'user' ? 'Vos' : 'Asistente' }}</span>
    <p class="bubble-content">{{ content }}</p>
    <TaskActionBlock
      v-if="actions?.length && !resolved"
      :actions="actions"
      @apply="$emit('apply')"
      @discard="$emit('discard')"
    />
  </div>
</template>

<style scoped>
.chat-bubble {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border);
  max-width: 92%;
}
.chat-bubble.is-user {
  align-self: flex-end;
  background: var(--panel-alt);
}
.chat-bubble.is-assistant {
  align-self: flex-start;
  background: var(--panel);
}
.bubble-role {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: var(--tracking-hd);
  color: var(--fg-dimmer);
}
.bubble-content {
  margin: 0;
  font-size: var(--fs-body-sm);
  color: var(--fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
