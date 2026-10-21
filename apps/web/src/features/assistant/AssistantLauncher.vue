<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useBackClose } from '@/composables/useBackClose';
import { useIsMobile } from '@/composables/useIsMobile';
import AssistantComposer from '@/features/assistant/AssistantComposer.vue';
import AssistantConversations from '@/features/assistant/AssistantConversations.vue';
import AssistantPanel from '@/features/assistant/AssistantPanel.vue';
import AssistantVoiceSheet from '@/features/assistant/AssistantVoiceSheet.vue';
import { useAssistantHistoryStore } from '@/features/assistant/historyStore';
import { useAssistantChatStore } from '@/features/assistant/store';
import { useReadAloud } from '@/features/assistant/voice/useReadAloud';
import { useVoiceStore } from '@/features/assistant/voice/voiceStore';
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
// burbuja (o la pestaña, en un teléfono) lo marca como no leído. En la cabecera,
// una sola línea: ☰ conversaciones, el título, 🔈 la voz (un sheet con leer en voz
// alta, la charla, la voz y la velocidad) y ✕. «Detener» también calla la voz.

const ui = useAssistantStore();
const chat = useAssistantChatStore();
const voice = useVoiceStore();
useReadAloud(() => chat.turns);

function stop() {
  chat.stop();
  voice.cancel();
}
const { isMobile } = useIsMobile();

/** Las conversaciones abiertas como cajón (bajo 768px, donde no hay lugar al costado). */
const drawer = ref(false);
/** El sheet de voz: leer, charla, voz y velocidad. Lo abren 🔈 y el chip de voz del composer. */
const voiceOpen = ref(false);

const history = useAssistantHistoryStore();
/** El título de la conversación abierta: el guardado, o su primera pregunta, o «Nueva». */
const title = computed(() => {
  const saved = history.items.find((c) => c.id === chat.conversationId);
  if (saved) return saved.title;
  const first = chat.turns.find((t) => t.kind === 'user');
  return first?.kind === 'user' ? first.text : 'Nueva conversación';
});

/** El agente con el que se habla, si el runner ofrece más de uno. */
const agentLabel = computed(() =>
  chat.agents.length > 1 ? chat.agents.find((a) => a.id === chat.agent)?.label : undefined,
);

function toggle() {
  if (ui.isOpen) ui.close();
  else ui.open();
}

// Una respuesta que terminó mientras el chat estaba cerrado.
watch(
  () => chat.streaming,
  (now, before) => {
    if (before && !now && !ui.isOpen && chat.turns.length) ui.unread = true;
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
    // En desktop el foco va a la caja de pregunta; en un teléfono eso abriría el teclado encima.
    if (!mobile) {
      await nextTick();
      document.getElementById('assistant-input')?.focus();
    }
  },
  { immediate: true },
);
onUnmounted(() => setLock(false));

// En un teléfono el asistente tapa la pantalla: el «atrás» lo cierra (y antes, el cajón de
// conversaciones si está abierto). En desktop flota con la página usable detrás: el «atrás» es de ella.
useBackClose(() => ui.isOpen, () => ui.close(), () => isMobile.value);
useBackClose(() => ui.isOpen && drawer.value, () => (drawer.value = false), () => isMobile.value);
watch(
  () => ui.isOpen,
  (open) => {
    if (!open) drawer.value = false;
  },
);
</script>

<template>
  <Teleport to="body">
    <section
      v-if="ui.isOpen"
      class="cw"
      role="dialog"
      aria-label="Asistente"
      @keydown.esc.stop="ui.close()"
    >
      <div v-if="drawer" class="cw__shade" aria-hidden="true" @click="drawer = false" />
      <div class="cw__list" :data-open="drawer">
        <AssistantConversations @picked="drawer = false" />
      </div>

      <div class="cw__chat">
        <header class="cw__head">
          <button type="button" class="cw__menu cw__icon" aria-label="Tus conversaciones" :aria-expanded="drawer" @click="drawer = !drawer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10" /></svg>
          </button>
          <span class="cw__heading">
            <span class="cw__ai" aria-hidden="true">✦</span>
            <span class="cw__title" data-test="title">{{ title }}</span>
            <span v-if="agentLabel" class="cw__agent">{{ agentLabel }}</span>
          </span>
          <button
            v-if="voice.supported"
            type="button"
            class="cw__icon"
            data-test="voice"
            :aria-pressed="voice.wantsSpeech"
            aria-label="Voz del asistente"
            title="Voz del asistente"
            @click="voiceOpen = true"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4z" /><path v-if="voice.wantsSpeech" d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" /></svg>
          </button>
          <button type="button" class="cw__icon" aria-label="Cerrar el asistente" @click="ui.close()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
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
            @send="chat.send($event, { voice: voice.wantsSpeech })"
            @stop="stop"
            @scope="chat.setScope($event)"
            @voice="voiceOpen = true"
          />
        </footer>
      </div>
    </section>
    <AssistantVoiceSheet :open="voiceOpen" @close="voiceOpen = false" />
  </Teleport>

  <!-- En un teléfono el asistente es una pestaña de la tab bar (AppShell): la burbuja es de desktop. -->
  <button
    v-if="!isMobile"
    type="button"
    class="fab"
    :class="{ 'fab--open': ui.isOpen }"
    aria-haspopup="dialog"
    :aria-expanded="ui.isOpen"
    :aria-label="ui.isOpen ? 'Cerrar el asistente' : 'Abrir el asistente'"
    @click="toggle"
  >
    <span aria-hidden="true">{{ ui.isOpen ? '✕' : '✦' }}</span>
    <span v-if="ui.unread" class="fab__unread" data-test="unread" aria-label="Respuesta nueva" />
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
   conversaciones, un cajón sobre el chat. Va sobre el detalle de una tarea (75): «Preguntarle al
   asistente» se abre desde ahí. Bajo el sheet de login (80), que el chat puede pedir. */
.cw {
  position: fixed;
  inset: 0;
  z-index: 78;
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
  gap: 0.1rem;
  min-height: var(--tap-h);
  padding: 0 0.25rem;
  border-bottom: 1px solid var(--border-mute);
}
.cw__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: var(--tap-h);
  height: var(--tap-h);
  border: none;
  border-radius: var(--radius);
  background: none;
  color: var(--fg-mute);
  cursor: pointer;
}
.cw__icon svg { width: 1.2rem; height: 1.2rem; }
.cw__icon:hover { background: var(--panel-hi); color: var(--fg); }
.cw__icon[aria-pressed='true'] { color: var(--accent); }
/* Una línea: ✦ y el título (el contexto ya está en el chip de la caja de pregunta). */
.cw__heading { display: flex; flex: 1; align-items: baseline; gap: 0.4rem; min-width: 0; padding-left: 0.25rem; }
.cw__ai { flex: none; color: var(--ai); }
.cw__title { min-width: 0; overflow: hidden; color: var(--fg); font-family: var(--font-display); font-size: var(--fs-body); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.cw__agent { flex: none; color: var(--fg-dim); font-size: var(--fs-chrome); }
/* Sólo la conversación scrollea: la cabecera y la caja de pregunta quedan quietas. */
.cw__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-bottom: 0.5rem; }
.cw__foot {
  flex: 0 0 auto;
  padding: 0.5rem 0.6rem calc(0.6rem + env(safe-area-inset-bottom, 0px));
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
