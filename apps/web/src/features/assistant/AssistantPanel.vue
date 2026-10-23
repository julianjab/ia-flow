<script setup lang="ts">
import type { AssistantProposal } from '@ia-flow/shared';
import { nextTick, onMounted, ref, watch } from 'vue';
import { useAssistantHistoryStore } from '@/features/assistant/historyStore';
import AssistantProposalCard from '@/features/assistant/AssistantProposalCard.vue';
import AssistantStart from '@/features/assistant/AssistantStart.vue';
import AssistantTaskList from '@/features/assistant/AssistantTaskList.vue';
import CopyButton from '@/ui/CopyButton.vue';
import { parseInline } from '@/features/assistant/format';
import { type ProposalChoice, useAssistantChatStore } from '@/features/assistant/store';
import { useVoiceStore } from '@/features/assistant/voice/voiceStore';
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
const voice = useVoiceStore();

/** «Escuchar» una respuesta (el resumen para el oído si vino); otra vez, la calla. */
function listen(turn: { id: number; text: string; spoken?: string }) {
  const key = `reply:${turn.id}`;
  if (voice.speaking === key) voice.cancel();
  else voice.say(turn.spoken ?? turn.text, key);
}

/** Los pasos de una respuesta. Una conversación retomada no los trae: queda el último que se vio. */
function stepsOf(turn: { steps?: string[]; activity: string | null }): string[] {
  return turn.steps ?? (turn.activity ? [turn.activity] : []);
}

const end = ref<HTMLElement | null>(null);

// Quien abrió el asistente pidió un contexto (p. ej. «Preguntarle al asistente»
// de una tarjeta): se fija acá, y una conversación es de UN contexto.
// Si además trajo la pregunta ya escrita, se manda en ese contexto (antes de retomar la última
// conversación guardada: con un turno en curso, `resumeLatest` no la pisa). Con una respuesta en
// curso —la de esa tarea, o la del contexto que se acaba de dejar, que tarda un tick en cortarse—
// espera a que termine: `send` la descartaría y lo escrito se perdería.
watch(
  () => [ui.request, ui.message, ui.topic, chat.streaming] as const,
  () => {
    const scope = ui.consumeRequest();
    if (scope) chat.setScope(scope);
    const about = ui.consumeTopic();
    if (about) chat.startTopic(about.title, about.context);
    if (!ui.message || chat.streaming) return;
    const question = ui.consumeMessage();
    if (question) void chat.send(question, { voice: voice.wantsSpeech });
  },
  { immediate: true },
);

onMounted(() => void chat.loadProjects());

// Un contexto que se abre vacío retoma su última conversación guardada (con ese agente).
const history = useAssistantHistoryStore();
watch(
  () => [chat.scope, chat.agent, session.github] as const,
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

/** Las columnas del board al que un issue propuesto se suma: de qué elegir antes de confirmar. */
function columnsOf(proposal: AssistantProposal): string[] | undefined {
  return 'board' in proposal && proposal.board ? chat.statuses[proposal.board.project_id] : undefined;
}

async function run(id: number, choice?: ProposalChoice) {
  const token = await session.token();
  if (token) void chat.runProposal(id, token, choice);
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
          <span class="ap__mark" aria-hidden="true">✦</span>
          <div class="ap__body">
            <!-- Lo que fue haciendo: ✓ lo terminado, y el paso actual girando mientras responde. -->
            <ol v-if="stepsOf(turn).length" class="ap__steps" data-test="steps">
              <li
                v-for="(step, i) in stepsOf(turn)"
                :key="i"
                class="ap__step mono"
                :data-now="turn.streaming && i === stepsOf(turn).length - 1"
              >
                {{ step }}
              </li>
            </ol>
            <p v-if="turn.text" class="ap__text">
              <template v-for="(seg, i) in parseInline(turn.text)" :key="i">
                <code v-if="seg.kind === 'code'" class="ap__code">{{ seg.text }}</code>
                <strong v-else-if="seg.kind === 'bold'">{{ seg.text }}</strong>
                <template v-else>{{ seg.text }}</template>
              </template>
            </p>
            <!-- Mientras no llega texto: el lugar de la respuesta, en vez de tres puntos. -->
            <span v-else-if="turn.streaming" class="ap__typing" role="status" aria-label="Pensando…">
              <span /><span /><span />
            </span>
            <div v-if="turn.text && !turn.streaming" class="ap__acts">
              <button
                v-if="voice.supported"
                type="button"
                class="ap__act"
                data-test="listen"
                :aria-pressed="voice.speaking === `reply:${turn.id}`"
                :aria-label="voice.speaking === `reply:${turn.id}` ? 'Dejar de leer' : 'Leer en voz alta'"
                :title="voice.speaking === `reply:${turn.id}` ? 'Dejar de leer' : 'Leer en voz alta'"
                @click="listen(turn)"
              >
                <svg v-if="voice.speaking === `reply:${turn.id}`" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4z" /><path d="M16.5 9a4 4 0 0 1 0 6" /></svg>
              </button>
              <CopyButton :value="turn.text" label="la respuesta" />
            </div>
          </div>
        </div>

        <AssistantProposalCard
          v-else-if="turn.kind === 'proposal'"
          :proposal="turn.proposal"
          :status="turn.status"
          :message="turn.message"
          :url="turn.url"
          :board-status="turn.boardStatus"
          :board-error="turn.boardError"
          :statuses="columnsOf(turn.proposal)"
          :error="turn.error"
          @run="(choice) => run(turn.id, choice)"
          @dismiss="chat.dismissProposal(turn.id)"
          @open="openTask"
        />

        <AssistantTaskList v-else-if="turn.kind === 'tasks'" :items="turn.items" @open="openTask" />

        <p v-else-if="turn.kind === 'topic'" class="ap__topic" data-test="topic">
          <span class="ap__topic-ai" aria-hidden="true">✦</span> {{ turn.text }}
        </p>

        <p v-else class="ap__note" role="alert">✕ {{ turn.text }}</p>
      </template>
      <span ref="end" />
    </div>

  </div>
</template>

<style scoped>
.ap { display: flex; flex-direction: column; min-height: 100%; }

.ap__thread { display: flex; flex-direction: column; gap: 1rem; padding: 0.75rem 1rem; }
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
/* El asistente no va en burbuja: es prosa, con ✦ en el margen (R16: `--ai` sólo como marca). */
.ap__msg--assistant { display: grid; grid-template-columns: 1rem minmax(0, 1fr); gap: 0 0.5rem; align-self: stretch; max-width: none; }
.ap__msg--assistant p { margin: 0; }
.ap__mark { color: var(--ai); font-size: var(--fs-chrome); line-height: 1.5rem; }
.ap__body { display: flex; flex-direction: column; gap: 0.45rem; min-width: 0; }
.ap__text { color: var(--fg); font-size: var(--fs-body); white-space: pre-wrap; }
.ap__code { padding: 0 0.25rem; border-radius: var(--radius-sm); background: var(--panel-hi); color: var(--fg); font-family: var(--font-mono); font-size: 0.92em; }
.ap__steps { display: flex; flex-direction: column; gap: 0.15rem; margin: 0; padding: 0; list-style: none; }
.ap__step { display: flex; align-items: center; gap: 0.45rem; color: var(--fg-dim); font-size: var(--fs-chrome); }
.ap__step::before { content: '✓'; flex: none; width: 0.75rem; color: var(--fg-dimmer); }
.ap__step[data-now='true'] { color: var(--fg-mute); }
.ap__step[data-now='true']::before {
  content: '';
  width: 0.6rem;
  height: 0.6rem;
  margin-inline: 0.075rem;
  border: 1.5px solid var(--border-hi);
  border-top-color: var(--ai);
  border-radius: 50%;
  animation: ap-spin 0.9s linear infinite;
}
/* Pensando: tres líneas con la forma de la respuesta que va a llegar. */
.ap__typing { display: flex; flex-direction: column; gap: 0.4rem; padding-top: 0.2rem; }
.ap__typing span { height: 0.55rem; border-radius: 2px; background: linear-gradient(90deg, var(--panel-alt) 0%, var(--panel-hi) 50%, var(--panel-alt) 100%); background-size: 200% 100%; animation: ap-shimmer 1.4s ease-in-out infinite; }
.ap__typing span:nth-child(1) { width: 92%; }
.ap__typing span:nth-child(2) { width: 76%; }
.ap__typing span:nth-child(3) { width: 52%; }
.ap__acts { display: flex; gap: 0.15rem; margin-left: -0.6rem; }
.ap__act {
  display: grid;
  place-items: center;
  width: var(--tap-h);
  height: var(--tap-h);
  border: 0;
  border-radius: 50%;
  background: none;
  color: var(--fg-dim);
  cursor: pointer;
}
.ap__act svg { width: 1.05rem; height: 1.05rem; }
.ap__act:hover,
.ap__act[aria-pressed='true'] { background: var(--panel-hi); color: var(--fg); }
@keyframes ap-spin { to { transform: rotate(360deg); } }
@keyframes ap-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) {
  .ap__step[data-now='true']::before,
  .ap__typing span { animation: none; }
}
.ap__note { margin: 0; color: var(--danger); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.ap__topic { align-self: flex-start; margin: 0; padding: 0.35rem 0.7rem; border-radius: var(--radius); background: var(--panel-hi); color: var(--fg-mute); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.ap__topic-ai { color: var(--ai); }
</style>
