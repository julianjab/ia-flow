<script setup lang="ts">
import { computed } from 'vue';
import { useTaskChatStore } from '@/features/tasks/taskChatStore';
import { rendererFor } from '@/features/tasks/viewBlocks/registry';

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
 * esas viven en `localStorage` (`taskNotePref.ts`) y hoy nadie las vuelve a
 * leer para mostrarlas fila por fila.
 */
const props = defineProps<{
  taskId: string
  /** Hay una operación en vuelo sobre ESTA fila — deshabilita sus botones sin
   *  congelar las demás. */
  busy?: boolean
}>()

const emit = defineEmits<{
  /** Una primitiva de vista pidió ejecutar una operación sobre esta fila. El
   *  overlay no la corre: necesita el proyecto activo y los toasts, que son de
   *  `TareasSection`. */
  runOp: [taskId: string, op: string]
}>()

const store = useTaskChatStore()

const actions = computed(() => store.pendingActionsByTask[props.taskId] ?? [])
const reply = computed(() => store.pendingReplyForTask(props.taskId))
const highlightReason = computed(() => store.highlights[props.taskId])

/** Los bloques que el contrato declaró de slot `row` para esta tarea, ya
 *  emparejados con el componente que los dibuja. Uno sin renderer se descarta
 *  acá (ver `registry.ts`) y no llega al template. */
const blocks = computed(() =>
  (store.rowBlocksByTask[props.taskId] ?? []).flatMap((block) => {
    const component = rendererFor(block.use)
    return component ? [{ block, component }] : []
  }),
)

const hasSomething = computed(
  () =>
    !!reply.value || actions.value.length > 0 || !!highlightReason.value || blocks.value.length > 0,
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

    <div v-if="blocks.length" class="overlay-blocks">
      <component
        :is="entry.component"
        v-for="(entry, i) in blocks"
        :key="`${entry.block.use}-${i}`"
        :block="entry.block"
        :task-id="taskId"
        :busy="!!busy"
        @run="(op: string) => emit('runOp', taskId, op)"
      />
    </div>

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
.overlay-blocks { display: flex; flex-wrap: wrap; gap: 0.4rem; }
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
