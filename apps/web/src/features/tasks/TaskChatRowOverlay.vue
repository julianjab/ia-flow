<script setup lang="ts">
import { computed } from 'vue';
import { useTaskChatStore } from '@/features/tasks/taskChatStore';

/**
 * Lo que el asistente propone SOBRE una fila real — no un chip suelto en un
 * drawer aparte (R18). Se monta como sibling de cada `<TaskRow>` (las 3
 * v-for de `TareasSection.vue`) y decide sola si tiene algo que dibujar.
 *
 * Riel de 2px a la izquierda + sangría a la columna de título: mismo patrón
 * visual que ya usa la fila para su "razón" (ver `TaskRow.vue`).
 *
 * **Deuda a propósito, fuera de alcance de este cambio**: sólo dibuja
 * propuestas STAGED (`pending`), no el historial de notas ya aplicadas —
 * eso necesita una fuente de datos por fila (`GET /notes?taskId=`) que hoy
 * no se pide en el listado (sería 1 request por fila visible). El backend
 * ya soporta leer/borrar esas notas (`chatApi.ts`); falta la vista.
 */
const props = defineProps<{
  taskId: string
}>()

const store = useTaskChatStore()

const actions = computed(() => store.pendingActionsByTask[props.taskId] ?? [])
const reply = computed(() => store.pendingReplyForTask(props.taskId))
const highlightReason = computed(() => store.highlights[props.taskId])

const hasSomething = computed(
  () => !!reply.value || actions.value.length > 0 || !!highlightReason.value,
)
</script>

<template>
  <li v-if="hasSomething" class="chat-row-overlay" :data-testid="`chat-overlay-${taskId}`">
    <div v-if="highlightReason" class="overlay-highlight">
      <span class="overlay-glyph">●</span>
      <span class="overlay-highlight-text">{{ highlightReason }}</span>
      <button type="button" class="overlay-dismiss" title="Quitar resalte" @click="store.clearHighlight(taskId)">✕</button>
    </div>

    <p v-if="reply" class="overlay-reply">{{ reply }}</p>

    <ul v-if="actions.length" class="overlay-actions">
      <li v-for="(action, i) in actions" :key="i" class="overlay-action">
        <template v-if="action.type === 'tag'">
          <span class="overlay-action-label">+tags:</span>
          <span v-for="tag in action.tags" :key="tag" class="overlay-tag-proposed">{{ tag }}</span>
        </template>
        <template v-else-if="action.type === 'note'">
          <span class="overlay-action-label">nota:</span>
          <span class="overlay-note-text">{{ action.text }}</span>
        </template>
      </li>
    </ul>
  </li>
</template>

<style scoped>
.chat-row-overlay {
  list-style: none;
  margin: 0;
  padding: 0.4rem 0.6rem 0.4rem calc(0.6rem + 2px);
  border-left: 2px solid var(--accent);
  background: var(--panel-alt);
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.overlay-highlight { display: flex; align-items: center; gap: 0.4rem; color: var(--warning, var(--accent)); }
.overlay-glyph { color: var(--warning, var(--accent)); }
.overlay-highlight-text { flex: 1; }
.overlay-dismiss {
  border: none;
  background: none;
  color: var(--fg-dimmer);
  cursor: pointer;
  padding: 0;
  height: var(--tap-h-sm);
  width: var(--tap-h-sm);
}
.overlay-reply { margin: 0; color: var(--fg); }
.overlay-actions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.overlay-action { display: flex; align-items: baseline; gap: 0.3rem; flex-wrap: wrap; }
.overlay-action-label { color: var(--fg-dim); }
.overlay-tag-proposed {
  border: 1px dashed var(--accent);
  padding: 0 0.3rem;
  color: var(--accent);
}
.overlay-note-text { color: var(--fg); }
</style>
