<script setup lang="ts">
import type { AssistantScope } from '@ia-flow/shared';
import { computed } from 'vue';
import { KIND_LABEL } from '@/components/taskLabels';
import ScopeTag from '@/features/assistant/ScopeTag.vue';
import { sameScope, useAssistantChatStore } from '@/features/assistant/store';

// Una conversación nueva: ¿con quién y de qué querés hablar? Si el runner ofrece
// más de un agente del asistente, primero se elige con cuál. Después, todo el
// runner, un proyecto, o una de las tareas que te necesitan — o escribí `#` / `@`
// en la caja. Abajo, las preguntas típicas, que la mandan de una.

const chat = useAssistantChatStore();

/** Las tareas más urgentes como atajo: las que te necesitan o fallaron, hasta cuatro. */
const urgent = computed(() =>
  chat.tasks.filter((t) => t.group === 'need' || t.group === 'fail').slice(0, 4),
);

const options = computed<Array<{ scope: AssistantScope; title: string; hint: string }>>(() => [
  { scope: { kind: 'general' }, title: 'Todo el runner', hint: 'salud, qué falló, qué atender' },
  ...chat.projects.map((p) => ({
    scope: { kind: 'project' as const, project_id: p.id },
    title: p.id,
    hint: 'su bandeja y su config',
  })),
  ...urgent.value.map((t) => ({
    scope: { kind: 'task' as const, ref: t.ref },
    title: t.title,
    hint: KIND_LABEL[t.kind],
  })),
]);
</script>

<template>
  <div class="st">
    <template v-if="chat.agents.length > 1">
      <h2 class="st__hd">¿Con quién?</h2>
      <div class="st__pick" role="group" aria-label="Agente del asistente">
        <button
          v-for="a in chat.agents"
          :key="a.id"
          type="button"
          class="st__opt"
          :data-test="`agent-${a.id}`"
          :aria-pressed="a.id === chat.agent"
          @click="chat.setAgent(a.id)"
        >
          <span class="st__title">{{ a.label }}</span>
          <span v-if="a.description" class="st__hint">{{ a.description }}</span>
        </button>
      </div>
    </template>

    <h2 class="st__hd" :class="{ 'st__hd--next': chat.agents.length > 1 }">¿De qué querés hablar?</h2>
    <p class="st__sub">O escribí en la caja: <span class="mono">#</span> una tarea, <span class="mono">@</span> un proyecto.</p>
    <div class="st__pick" role="group" aria-label="Contexto de la conversación">
      <button
        v-for="o in options"
        :key="JSON.stringify(o.scope)"
        type="button"
        class="st__opt"
        :aria-pressed="sameScope(o.scope, chat.scope)"
        @click="chat.setScope(o.scope)"
      >
        <ScopeTag :scope="o.scope" />
        <span class="st__title">{{ o.title }}</span>
        <span class="st__hint">{{ o.hint }}</span>
      </button>
    </div>

    <p v-if="chat.suggestions.length" class="uc-label st__lbl">para empezar</p>
    <div v-if="chat.suggestions.length" class="st__ask">
      <button v-for="s in chat.suggestions" :key="s" type="button" class="st__q" @click="chat.send(s)">{{ s }}</button>
    </div>
  </div>
</template>

<style scoped>
.st { display: flex; flex-direction: column; gap: 0.6rem; margin: auto 0; padding: 1rem 0.9rem; }
.st__hd { margin: 0; font-family: var(--font-body); font-size: var(--fs-body); font-weight: 600; text-align: center; text-transform: none; letter-spacing: 0; }
.st__hd--next { margin-top: 0.6rem; }
.st__sub { margin: 0 0 0.4rem; color: var(--fg-dim); font-size: var(--fs-body-sm); text-align: center; }
.st__pick { display: grid; grid-template-columns: 1fr; gap: 0.45rem; }
.st__opt {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.15rem;
  min-height: var(--tap-h-lg);
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-alt);
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.st__opt:hover { border-color: var(--border-hi); }
.st__opt[aria-pressed='true'] { border-color: var(--accent); }
.st__title { font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.st__hint { color: var(--fg-dim); font-size: var(--fs-chrome); }
.st__lbl { margin: 0.6rem 0 0; }
.st__ask { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.st__q { min-height: var(--tap-h-sm); padding: 0 0.75rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: none; color: var(--fg-mute); font-size: var(--fs-body-sm); text-align: left; cursor: pointer; }
.st__q:hover { background: var(--panel-alt); color: var(--fg); }

/* Con ancho, las opciones en dos columnas. */
@media (min-width: 640px) {
  .st__pick { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
