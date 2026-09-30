<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import AssistantHistory from '@/features/assistant/AssistantHistory.vue';
import AssistantProposalCard from '@/features/assistant/AssistantProposalCard.vue';
import AssistantTaskList from '@/features/assistant/AssistantTaskList.vue';
import { parseInline } from '@/features/assistant/format';
import { sameScope, useAssistantChatStore } from '@/features/assistant/store';
import { useAssistantStore } from '@/stores/assistant';
import { useGithubSessionStore } from '@/stores/githubSession';
import { useTaskFocusStore } from '@/stores/taskFocus';

// El cuerpo del asistente: chips de contexto (General / Proyecto / Tarea), la
// conversación y las sugerencias del contexto. El servidor es stateless; los
// turnos viven en `store.ts` y sobreviven a cerrar y abrir el asistente.

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
    <div class="ap__scopes" role="group" aria-label="Contexto">
      <button
        v-for="chip in chat.chips"
        :key="chip.key"
        type="button"
        class="ap__chip"
        :class="{ mono: chip.scope.kind === 'task' }"
        :aria-pressed="sameScope(chip.scope, chat.scope)"
        @click="chat.setScope(chip.scope)"
      >
        {{ chip.label }}
      </button>
    </div>

    <AssistantHistory />

    <div class="ap__thread" aria-live="polite">
      <p v-if="!chat.turns.length" class="ap__intro">
        Preguntá qué pasó con una tarea, por qué algo no corrió, o pedí que reintente, apruebe o
        mergee. Las acciones te las propone y vos las confirmás.
      </p>

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

    <div v-if="!chat.streaming" class="ap__suggest">
      <button
        v-for="s in chat.suggestions"
        :key="s"
        type="button"
        class="ap__chip ap__chip--ghost"
        @click="chat.send(s)"
      >
        {{ s }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ap { display: flex; flex-direction: column; min-height: 0; }
.ap__scopes,
.ap__suggest { display: flex; flex-wrap: wrap; gap: 0.35rem; padding: 0.5rem 1rem; }
.ap__suggest { border-top: 1px solid var(--border); }
/* Chip de filtro: `--tap-h-sm` (DESIGN_SYSTEM «Grilla vs. blanco táctil»). */
.ap__chip {
  min-height: var(--tap-h-sm);
  max-width: 100%;
  padding: 0 0.75rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius-sm);
  background: var(--panel-hi);
  color: var(--fg);
  font-size: var(--fs-body-sm);
  overflow-wrap: anywhere;
  text-align: left;
}
.ap__chip[aria-pressed='true'] { background: var(--accent); border-color: var(--accent); color: var(--panel); }
.ap__chip--ghost { background: none; border-color: var(--border); color: var(--fg-mute); }
.ap__chip:hover:not([aria-pressed='true']) { background: var(--panel-alt); color: var(--fg); }

.ap__thread { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.5rem 1rem; }
.ap__intro { margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); line-height: 1.5; }
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
