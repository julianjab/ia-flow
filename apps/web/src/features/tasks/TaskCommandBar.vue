<script setup lang="ts">
import type { TaskChatAction, TaskChatTaskContext } from '@ia-flow/shared';
import { computed, ref } from 'vue';
import TaskActionBlock from '@/features/tasks/TaskActionBlock.vue';
import { useTaskChatStore } from '@/features/tasks/taskChatStore';

/**
 * La barra de comandos del asistente — 44px integrada en la fila de filtros
 * (reemplaza al drawer/sheet viejo, ver #215/#216, regla R18).
 *
 * Sólo dibuja lo que es del PROYECTO en general: la respuesta cuando
 * `scope: { type: 'project' }`, el resumen de `reorder`/`group` (preferencias
 * de vista, no de una fila puntual) y la barra Aplicar/Descartar única — las
 * respuestas y acciones sobre UNA tarea puntual las dibuja
 * `TaskChatRowOverlay.vue`, sobre la fila real.
 */
const props = defineProps<{
  tasks: TaskChatTaskContext[]
  projectId: string
}>()

const emit = defineEmits<{
  apply: [actions: TaskChatAction[]]
}>()

const store = useTaskChatStore()
const message = ref('')

const SUGGESTIONS = [
  '¿Qué tarea debería priorizar hoy?',
  '¿Qué está bloqueado?',
  '¿Qué tareas están sin asignar?',
]

function ask(text: string): void {
  const trimmed = text.trim()
  if (!trimmed || store.busy || !props.projectId) return
  message.value = '';
  void store.ask({ projectId: props.projectId, message: trimmed, tasks: props.tasks })
}

const projectReply = computed(() =>
  store.pending?.scope.type === 'project' ? store.pending.reply : null,
);

const reorderAction = computed(() =>
  store.pending?.actions.find((a): a is TaskChatAction & { type: 'reorder' } => a.type === 'reorder'),
);

const groupAction = computed(() =>
  store.pending?.actions.find((a): a is TaskChatAction & { type: 'group' } => a.type === 'group'),
);

const pendingActionsCount = computed(() => store.pending?.actions.length ?? 0);

function onApply(): void {
  const actions = store.pending?.actions ?? [];
  if (actions.length) emit('apply', actions);
  else store.discard();
}
</script>

<template>
  <div class="task-command-bar">
    <form class="command-input-row" @submit.prevent="ask(message)">
      <span class="command-glyph" aria-hidden="true">✦</span>
      <input
        v-model="message"
        class="command-input"
        type="text"
        placeholder="Preguntale al asistente sobre esta lista…"
        :disabled="store.busy"
        data-testid="chat-input"
      />
      <button
        v-if="!store.busy"
        type="button"
        class="btn btn--ghost command-send"
        data-testid="chat-send"
        :disabled="!message.trim()"
        @click="ask(message)"
      >
        →
      </button>
      <button
        v-else
        type="button"
        class="btn btn--ghost command-stop"
        data-testid="chat-stop"
        @click="store.stop()"
      >
        Detener
      </button>
    </form>

    <p v-if="store.busy" class="command-status" data-testid="chat-busy">Pensando…</p>

    <div v-if="!store.history.length && !store.busy" class="command-suggestions">
      <button
        v-for="s in SUGGESTIONS"
        :key="s"
        type="button"
        class="command-suggestion"
        @click="ask(s)"
      >
        {{ s }}
      </button>
    </div>

    <div v-if="store.error" class="command-error">
      <p class="command-error-line"><span class="error-glyph">✕</span>{{ store.error }}</p>
      <button type="button" class="command-error-retry" @click="ask(store.lastAttemptedMessage ?? '')">
        <span class="error-glyph">→</span>reintentar
      </button>
    </div>

    <p v-if="projectReply" class="command-reply" data-testid="chat-project-reply">{{ projectReply }}</p>

    <p v-if="reorderAction" class="command-reorder" data-testid="chat-reorder-summary">
      Reordenar {{ reorderAction.taskIds.length }} tareas (sólo tu vista — no cambia el orden real)
    </p>

    <p v-if="groupAction" class="command-reorder" data-testid="chat-group-summary">
      {{ groupAction.enabled ? 'Agrupar por tema' : 'Desagrupar' }} (sólo tu vista)
    </p>

    <TaskActionBlock
      v-if="pendingActionsCount > 0"
      :actions-count="pendingActionsCount"
      @apply="onApply"
      @discard="store.discard()"
    />
  </div>
</template>

<style scoped>
.task-command-bar {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.command-input-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  height: var(--tap-h);
  border: 1px solid var(--border);
  padding: 0 0.5rem;
}
.command-glyph { color: var(--accent); flex: none; }
.command-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-input);
  height: 100%;
}
.command-input:focus { outline: none; }
.command-send,
.command-stop { height: var(--tap-h); flex: none; }
.command-status {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.command-suggestions { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.command-suggestion {
  border: 1px solid var(--border);
  background: none;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  height: var(--tap-h);
  padding: 0 0.6rem;
  cursor: pointer;
}
.command-error { display: flex; flex-direction: column; gap: 0.2rem; }
.command-error-line,
.command-error-retry {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.command-error-line { color: var(--danger); }
.command-error-retry {
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  text-align: left;
}
.error-glyph { margin-right: 0.3rem; }
.command-reply,
.command-reorder {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg);
}
</style>
