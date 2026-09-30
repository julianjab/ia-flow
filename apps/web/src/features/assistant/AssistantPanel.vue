<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { useAssistantHistoryStore } from '@/features/assistant/historyStore';
import AssistantProposalCard from '@/features/assistant/AssistantProposalCard.vue';
import AssistantStart from '@/features/assistant/AssistantStart.vue';
import AssistantTaskList from '@/features/assistant/AssistantTaskList.vue';
import { parseInline } from '@/features/assistant/format';
import { useAssistantChatStore } from '@/features/assistant/store';
import { useAssistantStore } from '@/stores/assistant';
import { useGithubSessionStore } from '@/stores/githubSession';
import { useTaskFocusStore } from '@/stores/taskFocus';

// El cuerpo del asistente: la conversación, o —si está vacía— de qué hablar. El
// contexto se elige ahí o en la caja de pregunta; los turnos viven en `store.ts` y
// sobreviven a cerrar y abrir el asistente.

const chat = useAssistantChatStore();
const ui = useAssistantStore();
const session = useGithubSessionStore();
const taskFocus = useTaskFocusStore();

const end = ref<HTMLElement | null>(null);

// Quien abrió el asistente pidió un contexto (p. ej. «Preguntarle al asistente»
// de una tarjeta): se fija acá, y una conversación es de UN contexto.
watch(
  () => ui.request,
  () => {
    const scope = ui.consumeRequest();
    if (scope) chat.setScope(scope);
  },
  { immediate: true },
);

onMounted(() => void chat.loadProjects());

// Un contexto que se abre vacío retoma su última conversación guardada.
const history = useAssistantHistoryStore();
watch(
  () => [chat.scope, session.github] as const,
  () => void history.resumeLatest(),
  { immediate: true },
);

// Sigue el final mientras llega texto, como un chat.
watch(
  () => chat.turns,
  async () => {
    await nextTick();
    end.value?.scrollIntoView?.({ block: 'end' });
  },
  { deep: true },
);

// Una tarea de la respuesta: se oculta el chat y la bandeja la abre (si se está
// en otra pantalla, `AppShell` vuelve a la bandeja). La conversación queda en el
// store: la burbuja la vuelve a mostrar tal cual.
function openTask(ref: string) {
  ui.close();
  taskFocus.focus(ref);
}

function run(id: number) {
  const github = session.github;
  if (github) void chat.runProposal(id, github.token);
  else session.requestLogin();
}
</script>

<template>
  <div class="ap">
    <AssistantStart v-if="!chat.turns.length" />

    <div v-else class="ap__thread" aria-live="polite">

      <template v-for="turn in chat.turns" :key="turn.id">
        <p v-if="turn.kind === 'user'" class="ap__msg ap__msg--user">{{ turn.text }}</p>

        <div v-else-if="turn.kind === 'assistant'" class="ap__msg ap__msg--assistant">
          <p v-if="turn.activity" class="ap__activity mono">· {{ turn.activity }}</p>
          <p v-if="turn.text" class="ap__bubble ap__text">
            <template v-for="(seg, i) in parseInline(turn.text)" :key="i">
              <code v-if="seg.kind === 'code'" class="ap__code">{{ seg.text }}</code>
              <strong v-else-if="seg.kind === 'bold'">{{ seg.text }}</strong>
              <template v-else>{{ seg.text }}</template>
            </template>
          </p>
          <p v-else-if="turn.streaming" class="ap__bubble ap__typing" aria-label="Pensando…">
            <span /><span /><span />
          </p>
        </div>

        <AssistantProposalCard
          v-else-if="turn.kind === 'proposal'"
          :proposal="turn.proposal"
          :status="turn.status"
          :message="turn.message"
          :error="turn.error"
          @run="run(turn.id)"
          @dismiss="chat.dismissProposal(turn.id)"
          @open="openTask"
        />

        <AssistantTaskList v-else-if="turn.kind === 'tasks'" :items="turn.items" @open="openTask" />

        <p v-else class="ap__note" role="alert">✕ {{ turn.text }}</p>
      </template>
      <span ref="end" />
    </div>

  </div>
</template>

<style scoped>
.ap { display: flex; flex-direction: column; min-height: 100%; }

.ap__thread { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.5rem 1rem; }
.ap__msg { margin: 0; max-width: 88%; min-width: 0; overflow-wrap: anywhere; font-size: var(--fs-body-sm); line-height: 1.5; }
/* Burbujas de chat: el radio es el del sistema ×3 y la esquina de donde "sale" el
   mensaje queda en `--radius-sm`. Quien pregunta, a la derecha; el asistente, a
   la izquierda, con el borde de lo que escribió el modelo (R16: `--ai` sólo como marca). */
.ap__msg--user {
  align-self: flex-end;
  padding: 0.45rem 0.75rem;
  border-radius: calc(var(--radius) * 3) calc(var(--radius) * 3) var(--radius-sm) calc(var(--radius) * 3);
  background: var(--panel-hi);
  color: var(--fg);
  white-space: pre-wrap;
}
.ap__msg--assistant { display: flex; flex-direction: column; gap: 0.2rem; align-self: flex-start; }
.ap__msg--assistant p { margin: 0; }
.ap__bubble {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-left: 2px solid var(--ai);
  border-radius: calc(var(--radius) * 3) calc(var(--radius) * 3) calc(var(--radius) * 3) var(--radius-sm);
  background: var(--panel-alt);
}
.ap__text { color: var(--fg); white-space: pre-wrap; }
.ap__code { padding: 0 0.25rem; border-radius: var(--radius-sm); background: var(--panel-hi); color: var(--fg); font-family: var(--font-mono); font-size: 0.92em; }
.ap__activity { padding-left: 0.25rem; color: var(--fg-dim); font-size: var(--fs-micro); }
/* «Escribiendo…»: tres puntos, en lugar de un texto que parpadea. */
.ap__typing { display: inline-flex; gap: 0.3rem; align-self: flex-start; padding: 0.7rem 0.85rem; }
.ap__typing span { width: 0.4rem; height: 0.4rem; border-radius: 50%; background: var(--fg-dim); animation: ap-dot 1.2s ease-in-out infinite; }
.ap__typing span:nth-child(2) { animation-delay: 0.15s; }
.ap__typing span:nth-child(3) { animation-delay: 0.3s; }
@keyframes ap-dot {
  0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-0.15rem); }
}
.ap__note { margin: 0; color: var(--danger); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
</style>
