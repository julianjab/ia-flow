<script setup lang="ts">
import AssistantComposer from '@/features/assistant/AssistantComposer.vue';
import AssistantPanel from '@/features/assistant/AssistantPanel.vue';
import { useAssistantChatStore } from '@/features/assistant/store';
import { useAssistantStore } from '@/stores/assistant';
import BottomSheet from '@/ui/BottomSheet.vue';

// El ÚNICO punto de entrada al asistente: un botón flotante y su sheet. Se monta
// una vez, en App.vue. Bajo 768px es un bottom sheet (R6); arriba, el mismo
// contenedor dibujado centrado. La bandeja lo abre ya apuntado a una tarea con
// `useAssistantStore().open({ kind: 'task', ref })`.

const ui = useAssistantStore();
const chat = useAssistantChatStore();

function close() {
  chat.stop();
  ui.close();
}
</script>

<template>
  <button
    v-if="!ui.isOpen"
    type="button"
    class="fab"
    aria-haspopup="dialog"
    @click="ui.open()"
  >
    <span aria-hidden="true">✦</span> Preguntar
  </button>

  <BottomSheet :open="ui.isOpen" title="Asistente · propone, vos confirmás" @close="close">
    <AssistantPanel />
    <template #footer>
      <AssistantComposer
        :placeholder="chat.placeholder"
        :streaming="chat.streaming"
        @send="chat.send($event)"
        @stop="chat.stop()"
      />
    </template>
  </BottomSheet>
</template>

<style scoped>
/* Un solo botón flotante: `--tap-h-lg`, el principal de la pantalla. Sin sombra
   de color (DESIGN_SYSTEM «Radio y sombra»); el borde lo despega del fondo. */
.fab {
  position: fixed;
  right: 1rem;
  bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: var(--tap-h-lg);
  padding: 0 1.1rem;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent);
  color: var(--panel);
  font-family: var(--font-body);
  font-size: var(--fs-body);
  font-weight: 600;
  cursor: pointer;
}
.fab:hover { background: var(--green-hi); border-color: var(--green-hi); }
</style>
