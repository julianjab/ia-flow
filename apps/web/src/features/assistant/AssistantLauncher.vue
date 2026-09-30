<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useIsMobile } from '@/composables/useIsMobile';
import AssistantComposer from '@/features/assistant/AssistantComposer.vue';
import AssistantConversations from '@/features/assistant/AssistantConversations.vue';
import AssistantPanel from '@/features/assistant/AssistantPanel.vue';
import { useAssistantHistoryStore } from '@/features/assistant/historyStore';
import { scopeSentence } from '@/features/assistant/scope';
import { useAssistantChatStore } from '@/features/assistant/store';
import { useAssistantStore } from '@/stores/assistant';

// El ÚNICO punto de entrada al asistente: una burbuja flotante que abre y
// cierra una ventana de chat — tus conversaciones al costado, la abierta al lado. Se monta una vez, en App.vue; la bandeja lo abre
// ya apuntado a una tarea con `useAssistantStore().open({ kind: 'task', ref })`.
//
// Sobre 768px la ventana flota abajo a la derecha, sin backdrop: la bandeja
// sigue viva detrás (tocar una tarea del chat oculta el chat y la abre). Bajo 768px
// ocupa la pantalla (R6: en táctil nada flota anclado) y bloquea el scroll de
// atrás; ahí las conversaciones son un cajón detrás de ☰. Cerrar no corta una
// respuesta en curso: sigue llegando, y si termina con el chat cerrado la
// burbuja lo marca como no leído.

const ui = useAssistantStore();
const chat = useAssistantChatStore();
const { isMobile } = useIsMobile();

const unread = ref(false);
/** Las conversaciones abiertas como cajón (bajo 768px, donde no hay lugar al costado). */
const drawer = ref(false);

const history = useAssistantHistoryStore();
/** El título de la conversación abierta: el guardado, o su primera pregunta, o «Nueva». */
const title = computed(() => {
  const saved = history.items.find((c) => c.id === chat.conversationId);
  if (saved) return saved.title;
  const first = chat.turns.find((t) => t.kind === 'user');
  return first?.kind === 'user' ? first.text : 'Nueva conversación';
});

function toggle() {
  if (ui.isOpen) ui.close();
  else ui.open();
}

// Una respuesta que terminó mientras el chat estaba cerrado.
watch(
  () => chat.streaming,
  (now, before) => {
    if (before && !now && !ui.isOpen && chat.turns.length) unread.value = true;
  },
);

function setLock(on: boolean) {
  if (typeof document !== 'undefined') document.body.style.overflow = on ? 'hidden' : '';
}

watch(
  () => [ui.isOpen, isMobile.value] as const,
  async ([open, mobile]) => {
    setLock(open && mobile);
    if (!open) return;
    unread.value = false;
    // En desktop el foco va a la caja de pregunta; en un teléfono eso abriría el teclado encima.
    if (!mobile) {
      await nextTick();
      document.getElementById('assistant-input')?.focus();
    }
  },
  { immediate: true },
);
onUnmounted(() => setLock(false));
</script>

<template>
  <Teleport to="body">
    <section
      v-if="ui.isOpen"
      class="cw"
      role="dialog"
      aria-label="Asistente"
      @keydown.esc="ui.close()"
    >
      <div v-if="drawer" class="cw__shade" aria-hidden="true" @click="drawer = false" />
      <div class="cw__list" :data-open="drawer">
        <AssistantConversations @picked="drawer = false" />
      </div>

      <div class="cw__chat">
        <header class="cw__head">
          <button type="button" class="cw__menu" aria-label="Tus conversaciones" :aria-expanded="drawer" @click="drawer = !drawer">☰</button>
          <span class="cw__ai" aria-hidden="true">✦</span>
          <span class="cw__heading">
            <span class="cw__title" data-test="title">{{ title }}</span>
            <span class="cw__sub">{{ scopeSentence(chat.scope) }} · propone, vos confirmás</span>
          </span>
          <button type="button" class="cw__close" aria-label="Cerrar el asistente" @click="ui.close()">✕</button>
        </header>
        <div class="cw__body">
          <AssistantPanel />
        </div>
        <footer class="cw__foot">
          <AssistantComposer
            :placeholder="chat.placeholder"
            :streaming="chat.streaming"
            :scope="chat.scope"
            :tasks="chat.tasks"
            :projects="chat.projects"
            @send="chat.send($event)"
            @stop="chat.stop()"
            @scope="chat.setScope($event)"
          />
        </footer>
      </div>
    </section>
  </Teleport>

  <!-- En un teléfono la ventana tapa todo y trae su ✕: la burbuja sobra. -->
  <button
    v-if="!(ui.isOpen && isMobile)"
    type="button"
    class="fab"
    :class="{ 'fab--open': ui.isOpen }"
    aria-haspopup="dialog"
    :aria-expanded="ui.isOpen"
    :aria-label="ui.isOpen ? 'Cerrar el asistente' : 'Abrir el asistente'"
    @click="toggle"
  >
    <span aria-hidden="true">{{ ui.isOpen ? '✕' : '✦' }}</span>
    <span v-if="unread" class="fab__unread" data-test="unread" aria-label="Respuesta nueva" />
  </button>
</template>

<style scoped>
/* La burbuja: un círculo de `--tap-h-lg`, el botón principal de la pantalla. Es
   la forma de un launcher de chat, no un radio (los radios siguen por token).
   Sin sombra de color (DESIGN_SYSTEM «Radio y sombra»): el borde la despega. */
.fab {
  position: fixed;
  right: 1rem;
  bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  z-index: 60;
  display: grid;
  place-items: center;
  width: calc(var(--tap-h-lg) * 1.15);
  height: calc(var(--tap-h-lg) * 1.15);
  border: 1px solid var(--accent);
  border-radius: 50%;
  background: var(--accent);
  color: var(--panel);
  font-family: var(--font-body);
  font-size: var(--fs-body);
  font-weight: 600;
  cursor: pointer;
}
.fab:hover { background: var(--green-hi); border-color: var(--green-hi); }
.fab:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.fab--open { background: var(--panel-hi); border-color: var(--border-hi); color: var(--fg); }
.fab--open:hover { background: var(--panel-alt); border-color: var(--border-hi); }
.fab__unread {
  position: absolute;
  top: 0.1rem;
  right: 0.1rem;
  width: 0.7rem;
  height: 0.7rem;
  border: 2px solid var(--bg);
  border-radius: 50%;
  background: var(--ai);
}

/* La ventana. Mobile primero (R8): pantalla completa, respetando las zonas seguras; las
   conversaciones, un cajón sobre el chat. */
.cw {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  min-height: 0;
  padding-top: env(safe-area-inset-top, 0px);
  background: var(--panel);
  animation: cw-in 150ms ease;
}
@keyframes cw-in {
  from { opacity: 0; transform: translateY(0.75rem); }
  to { opacity: 1; transform: translateY(0); }
}
.cw__list {
  position: absolute;
  inset: env(safe-area-inset-top, 0px) auto 0 0;
  z-index: 2;
  width: min(20rem, 85%);
  border-right: 1px solid var(--border-hi);
  transform: translateX(-102%);
  visibility: hidden;
  transition: transform 150ms ease, visibility 150ms;
}
.cw__list[data-open='true'] { transform: none; visibility: visible; }
.cw__shade { position: absolute; inset: 0; z-index: 1; background: rgba(0, 0, 0, 0.55); }
.cw__chat { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.cw__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-height: var(--tap-h);
  padding: 0 0.35rem 0 0;
  border-bottom: 1px solid var(--border);
}
.cw__menu,
.cw__close {
  flex: none;
  width: var(--tap-h);
  height: var(--tap-h);
  border: none;
  background: none;
  color: var(--fg-dim);
  font-size: var(--fs-body);
  cursor: pointer;
}
.cw__close { font-family: var(--font-mono); font-size: var(--fs-body-sm); }
.cw__menu:hover,
.cw__close:hover { color: var(--fg); }
.cw__ai { flex: none; color: var(--ai); }
.cw__heading { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.cw__title { overflow: hidden; color: var(--fg); font-size: var(--fs-body-sm); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.cw__sub { overflow: hidden; color: var(--fg-dim); font-size: var(--fs-micro); text-overflow: ellipsis; white-space: nowrap; }
/* Sólo la conversación scrollea: la cabecera y la caja de pregunta quedan quietas. */
.cw__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-bottom: 0.5rem; }
.cw__foot {
  flex: 0 0 auto;
  padding: 0.6rem 0.75rem calc(0.6rem + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border);
}

/* Sobre --bp-shell: flota sobre la burbuja, abajo a la derecha, con las conversaciones al
   costado (sin cajón ni ☰) y la página usable detrás. */
@media (min-width: 768px) {
  .cw {
    inset: auto 1rem calc(1rem + var(--tap-h-lg) * 1.15 + 0.75rem) auto;
    width: min(56rem, calc(100vw - 2rem));
    /* Nunca tapa la barra de arriba (`--tap-h`): arranca debajo de ella. */
    height: min(42rem, calc(100dvh - var(--tap-h-lg) * 1.15 - var(--tap-h) - 3rem));
    padding-top: 0;
    border: 1px solid var(--border-hi);
    border-radius: calc(var(--radius) * 3);
    overflow: hidden;
  }
  .cw__list { position: static; flex: 0 0 15.5rem; width: auto; border-right: 1px solid var(--border); transform: none; visibility: visible; transition: none; }
  .cw__shade,
  .cw__menu { display: none; }
  .cw__head { padding-left: 0.75rem; }
  .cw__foot { padding-bottom: 0.6rem; }
}
</style>
