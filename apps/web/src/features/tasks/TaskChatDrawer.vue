<script setup lang="ts">
import type { TaskChatAction, TaskChatMessage, TaskChatTaskContext } from '@ia-flow/shared';
import { TASK_CHAT_MAX_MESSAGES } from '@ia-flow/shared';
import { nextTick, ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { sendTaskChatMessage } from '@/features/tasks/chatApi';
import ChatBubble from '@/features/tasks/ChatBubble.vue';

/**
 * El panel de chat de Tareas — drawer lateral (≥768px) / sheet full-screen
 * (<768px), mismo patrón de `Teleport to="body"` que `TaskDetailModal.vue`.
 *
 * El historial vive ACÁ, en memoria, mientras el panel está montado (R del
 * PRD: sin persistencia). Cerrar y volver a abrir arranca en blanco.
 */
const props = defineProps<{
  open: boolean;
  projectId: string | null;
  tasks: TaskChatTaskContext[];
}>();

const emit = defineEmits<{
  close: [];
  /** El padre es quien tiene `setProjectItemField` y quien refresca la lista
   *  después — mismo criterio que `TaskDetailModal`'s `move` (ver
   *  `TareasSection.vue`): quien muta es quien recarga. */
  apply: [actions: TaskChatAction[]];
}>();

interface ChatEntry extends TaskChatMessage {
  /** Las acciones de este mensaje ya se aplicaron o descartaron: el bloque de
   *  chips deja de ofrecerse (una vez tocado el botón no hay vuelta atrás). */
  resolved: boolean;
}

const SUGGESTIONS = [
  '¿Qué tarea debería priorizar hoy?',
  '¿Qué está bloqueado?',
  '¿Qué tareas están sin asignar?',
];

const messages = ref<ChatEntry[]>([]);
const inputText = ref('');
const sending = ref(false);
const error = ref<string | null>(null);
const bodyEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);

function scrollToEnd(): void {
  void nextTick(() => {
    if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
  });
}

async function requestReply(): Promise<void> {
  if (!props.projectId) {
    error.value = 'Seleccioná un proyecto primero.';
    return;
  }
  sending.value = true;
  error.value = null;
  try {
    // Tope del contrato (`TASK_CHAT_MAX_MESSAGES`): una conversación larga
    // manda sólo su cola — el modelo pierde el arranque, no el turno actual.
    const history = messages.value.slice(-TASK_CHAT_MAX_MESSAGES);
    const reply = await sendTaskChatMessage(props.projectId, history, props.tasks);
    messages.value.push({ role: 'assistant', content: reply.reply, actions: reply.actions, resolved: false });
    scrollToEnd();
  } catch (e) {
    error.value = extractErrorMessage(e);
  } finally {
    sending.value = false;
  }
}

function send(text: string): void {
  const trimmed = text.trim();
  if (!trimmed || sending.value) return;
  messages.value.push({ role: 'user', content: trimmed, actions: [], resolved: true });
  inputText.value = '';
  scrollToEnd();
  void requestReply();
}

function onSubmit(): void {
  send(inputText.value);
}

/** Reintentar NO vuelve a empujar la burbuja del usuario — ya está en
 *  `messages`, y el server la vuelve a leer como el último mensaje. */
function retry(): void {
  void requestReply();
}

function resolveEntry(entry: ChatEntry): void {
  entry.resolved = true;
}

function applyEntry(entry: ChatEntry): void {
  emit('apply', entry.actions);
  resolveEntry(entry);
}

function close(): void {
  emit('close');
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}

/** Arranca en blanco cada vez que se abre — la conservación de sesión es
 *  "mientras está montado", no "entre aperturas". */
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    messages.value = [];
    inputText.value = '';
    error.value = null;
    void nextTick(() => inputEl.value?.focus());
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="tc-backdrop" @click.self="close" @keydown="onKeydown">
      <div class="tc-panel" role="dialog" aria-label="Asistente de tareas">
        <header class="tc-head">
          <span class="tc-title">✦ Asistente</span>
          <button type="button" class="tc-close" aria-label="Cerrar" @click="close">✕</button>
        </header>

        <div ref="bodyEl" class="tc-body">
          <div v-if="!messages.length" class="tc-empty">
            <p class="tc-empty-hint">Preguntale algo sobre las tareas de este proyecto.</p>
            <div class="tc-suggestions">
              <button
                v-for="s in SUGGESTIONS"
                :key="s"
                type="button"
                class="tc-suggestion"
                @click="send(s)"
              >{{ s }}</button>
            </div>
          </div>

          <ChatBubble
            v-for="(m, i) in messages"
            :key="i"
            :role="m.role"
            :content="m.content"
            :actions="m.actions"
            :resolved="m.resolved"
            @apply="applyEntry(m)"
            @discard="resolveEntry(m)"
          />

          <p v-if="sending" class="tc-thinking">Pensando…</p>

          <div v-if="error" class="tc-error">
            <p class="tc-error-line"><span class="tc-error-glyph">✕</span>{{ error }}</p>
            <button type="button" class="tc-error-retry" @click="retry">
              <span class="tc-error-glyph">→</span>Reintentar
            </button>
          </div>
        </div>

        <form class="tc-foot" @submit.prevent="onSubmit">
          <textarea
            ref="inputEl"
            v-model="inputText"
            class="tc-input"
            rows="1"
            placeholder="Escribí un mensaje…"
            :disabled="sending"
            data-testid="chat-input"
            @keydown.enter.exact.prevent="onSubmit"
          />
          <button
            type="submit"
            class="btn btn--primary tc-send"
            :disabled="sending || !inputText.trim()"
            data-testid="chat-send"
          >Enviar</button>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tc-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  z-index: 210;
}
.tc-panel {
  background: var(--panel);
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
}

@media (min-width: 768px) {
  .tc-backdrop { background: rgba(0, 0, 0, 0.25); }
  .tc-panel { width: min(420px, 100%); }
}

.tc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem 0.75rem;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.tc-title {
  font-size: var(--fs-body);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: var(--tracking-hd);
  color: var(--accent);
}
.tc-close {
  background: none;
  border: none;
  color: var(--fg-dim);
  font-size: var(--fs-body);
  cursor: pointer;
  padding: 0.2rem 0.35rem;
  line-height: 1;
}
.tc-close:hover { color: var(--fg); }

.tc-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
}

.tc-empty { display: flex; flex-direction: column; gap: 0.6rem; }
.tc-empty-hint { margin: 0; font-size: var(--fs-chrome); color: var(--fg-dim); }
.tc-suggestions { display: flex; flex-direction: column; gap: 0.4rem; }
.tc-suggestion {
  text-align: left;
  min-height: var(--tap-h);
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border);
  background: var(--panel-alt);
  color: var(--fg);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.tc-suggestion:hover { border-color: var(--accent); color: var(--accent); }

.tc-thinking { margin: 0; font-size: var(--fs-micro); color: var(--fg-dimmer); font-style: italic; }

.tc-error {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--danger);
  background: var(--red-bg);
}
.tc-error-line { margin: 0; font-size: var(--fs-body-sm); color: var(--danger); }
.tc-error-retry {
  align-self: flex-start;
  background: none;
  border: none;
  padding: 0;
  color: var(--info);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.tc-error-glyph { margin-right: 0.3rem; }

.tc-foot {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem 1rem;
  border-top: 1px solid var(--panel-hi);
  flex-shrink: 0;
}
.tc-input {
  flex: 1;
  min-height: var(--tap-h);
  max-height: 6rem;
  resize: vertical;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border);
  background: var(--panel-alt);
  color: var(--fg);
  font-family: inherit;
  font-size: var(--fs-input, var(--fs-body-sm));
}
.tc-input:disabled { opacity: 0.6; }
.tc-send { height: var(--tap-h); flex-shrink: 0; }
</style>
