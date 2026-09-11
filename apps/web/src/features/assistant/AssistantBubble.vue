<script setup lang="ts">
// Bubble button del asistente conversacional — flotante, visible en toda la
// app. Contexto automático: si la ruta activa es projects.detail, manda
// projectId (siempre) y taskId (cuando el tab actual muestra el detalle de
// una tarea puntual) para que el agente no tenga que preguntarlo.
import { useServerEvents } from '@/composables/useServerEvents'
import type { AssistantChatMessage } from '@ia-flow/shared'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAssistantStore } from './store.js'

const store = useAssistantStore()
const route = useRoute()
const draft = ref('')
const scroller = ref<HTMLElement | null>(null)

const context = computed(() => {
  if (route.name !== 'projects.detail') return {}
  const projectId = String(route.params.id ?? '') || undefined
  const taskId = typeof route.params.detailId === 'string' ? route.params.detailId : undefined
  return { projectId, taskId }
})

useServerEvents((msg) => {
  if (msg.type !== 'assistant:message') return
  store.receive(msg as unknown as AssistantChatMessage)
})

watch(
  () => store.isOpen,
  async (open) => {
    if (!open) return
    await store.hydrate()
    await scrollToBottom()
  },
)

watch(
  () => store.messages.length,
  async () => {
    await scrollToBottom()
  },
)

async function scrollToBottom() {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
}

async function submit() {
  const text = draft.value
  draft.value = ''
  await store.send(text, context.value)
}
</script>

<template>
  <div class="assistant-bubble">
    <div v-if="store.isOpen" class="panel">
      <header>
        <span class="uc-label">Asistente</span>
        <div class="header-actions">
          <button type="button" class="btn-icon" title="Limpiar conversación" @click="store.clear()">
            ↺
          </button>
          <button type="button" class="btn-icon" title="Cerrar" @click="store.toggle()">✕</button>
        </div>
      </header>
      <div ref="scroller" class="messages">
        <p v-if="!store.hasMessages" class="empty">
          Preguntame por qué falló una tarea, cómo va, o cómo funciona el engine.
        </p>
        <div
          v-for="message in store.messages"
          :key="message.id"
          class="message"
          :class="{ 'from-user': message.author === 'user' }"
        >
          {{ message.body }}
        </div>
        <div v-if="store.waitingReply" class="message typing">…</div>
      </div>
      <form class="composer" @submit.prevent="submit">
        <input v-model="draft" type="text" placeholder="Escribí un mensaje…" :disabled="store.sending" />
        <button type="submit" class="btn" :disabled="store.sending || !draft.trim()">Enviar</button>
      </form>
    </div>
    <button type="button" class="fab" :aria-expanded="store.isOpen" @click="store.toggle()">
      {{ store.isOpen ? '✕' : '💬' }}
    </button>
  </div>
</template>

<style scoped>
.assistant-bubble {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.5rem;
}

.fab {
  width: var(--tap-h-lg);
  height: var(--tap-h-lg);
  border-radius: 50%;
  border: 1px solid var(--border-hi);
  background: var(--panel-hi);
  color: var(--fg);
  font-size: 1.2rem;
  cursor: pointer;
}

.panel {
  width: min(22rem, calc(100vw - 2rem));
  max-height: min(32rem, calc(100vh - 6rem));
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-mute);
  background: var(--panel-alt);
}

.header-actions {
  display: flex;
  gap: 0.25rem;
}

.btn-icon {
  min-width: var(--tap-h-sm);
  min-height: var(--tap-h-sm);
  border: none;
  background: transparent;
  color: var(--fg-mute);
  cursor: pointer;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: var(--fs-body-sm);
}

.empty {
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
}

.message {
  align-self: flex-start;
  max-width: 85%;
  padding: 0.4rem 0.6rem;
  border-radius: var(--radius);
  background: var(--panel-alt);
  color: var(--fg);
  white-space: pre-wrap;
}

.message.from-user {
  align-self: flex-end;
  background: var(--accent);
  color: var(--bg);
}

.message.typing {
  color: var(--fg-dim);
}

.composer {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem;
  border-top: 1px solid var(--border-mute);
}

.composer input {
  flex: 1;
  min-height: var(--tap-h);
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--fg);
  padding: 0 0.6rem;
  font-size: var(--fs-input);
}
</style>
