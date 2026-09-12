<script setup lang="ts">
// Bubble button del asistente conversacional — flotante, visible en toda la
// app. Contexto automático: si la ruta activa es projects.detail, manda
// projectId (siempre) y taskId (cuando el tab actual muestra el detalle de
// una tarea puntual) para que el agente no tenga que preguntarlo.
import { useServerEvents } from '@/composables/useServerEvents'
import type { AssistantChatMessage } from '@ia-flow/shared'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAssistantStore } from './store.js'
import { parseMessageBlocks } from './message-blocks.js'

const store = useAssistantStore()
const route = useRoute()
const router = useRouter()
const draft = ref('')
const scroller = ref<HTMLElement | null>(null)

function goTo(path: string) {
  store.toggle()
  router.push(path)
}

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
          <template v-for="(block, index) in parseMessageBlocks(message.body)" :key="index">
            <hr v-if="block.type === 'divider'" class="msg-divider" />
            <strong v-else-if="block.type === 'bold'">{{ block.text }}</strong>
            <code v-else-if="block.type === 'code'" class="msg-code">{{ block.text }}</code>
            <button
              v-else-if="block.type === 'link'"
              type="button"
              class="message-link"
              @click="goTo(block.path)"
            >
              {{ block.text }}
            </button>
            <button
              v-else-if="block.type === 'task-card' || block.type === 'project-card'"
              type="button"
              class="ref-card"
              @click="goTo(block.path)"
            >
              <span class="ref-card-title">{{ block.type === 'task-card' ? block.title : block.name }}</span>
              <span v-if="block.type === 'task-card' && block.status" class="ref-card-status">{{ block.status }}</span>
            </button>
            <template v-else>{{ block.text }}</template>
          </template>
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

.message-link {
  display: inline;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
  font: inherit;
}

.msg-divider {
  width: 100%;
  margin: 0.5rem 0;
  border: none;
  border-top: 1px solid var(--border-mute);
}

.msg-code {
  padding: 0.05rem 0.3rem;
  border-radius: var(--radius-sm);
  background: var(--panel-alt);
  font-family: var(--font-mono, monospace);
  font-size: 0.9em;
}

.ref-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  margin: 0.35rem 0;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--fg);
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.ref-card:hover {
  border-color: var(--border-hi);
}

.ref-card-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref-card-status {
  flex-shrink: 0;
  padding: 0.1rem 0.4rem;
  border-radius: var(--radius-sm);
  background: var(--panel-alt);
  color: var(--fg-mute);
  font-size: var(--fs-body-xs, 0.7rem);
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
