<script setup lang="ts">
// Drawer lateral del asistente conversacional — full-height, docked al
// borde derecho, visible en toda la app. Dos columnas en escritorio (lista
// de conversaciones + chat activo); en mobile (<768px, ver
// DESIGN_SYSTEM.md) colapsa a una sola pantalla por vez, controlado por
// `mobileView` más abajo.
//
// Contexto automático: si la ruta activa es projects.detail, manda
// projectId (siempre) y taskId (cuando el tab actual muestra el detalle de
// una tarea puntual) para que el agente no tenga que preguntarlo.
import { useServerEvents } from '@/composables/useServerEvents'
import { formatRelative } from '@/composables/formatRelative'
import ConfirmDialog from '@/ui/ConfirmDialog.vue'
import type { AssistantChatMessage } from '@ia-flow/shared'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAssistantStore } from '@/stores/assistant.js'
import { parseMessageBlocks } from './message-blocks.js'

const COLLAPSE_KEY = 'ia-flow:assistant:list-collapsed'

const store = useAssistantStore()
const route = useRoute()
const router = useRouter()
const draft = ref('')
const scroller = ref<HTMLElement | null>(null)
// Sólo importa bajo el breakpoint táctil — arriba las dos columnas se ven
// siempre, sin importar este valor (ver el CSS de `.drawer-body`).
const mobileView = ref<'list' | 'chat'>('list')
// Sólo importa en escritorio — colapsar la columna de hilos para que el
// chat ocupe todo el drawer (ver el CSS de `.drawer.collapsed`). En mobile
// ya es una sola columna por vez vía `mobileView`.
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}
const listCollapsed = ref(readCollapsed())
const deleteTarget = ref<string | null>(null)

function toggleListCollapsed() {
  listCollapsed.value = !listCollapsed.value
  try {
    localStorage.setItem(COLLAPSE_KEY, listCollapsed.value ? '1' : '0')
  } catch {
    // Storage bloqueado — la preferencia no sobrevive el reload, no es un
    // error visible (mismo criterio que `threads` en store.ts).
  }
}

async function confirmDelete() {
  const id = deleteTarget.value
  deleteTarget.value = null
  if (!id) return
  await store.deleteThread(id)
  await scrollToBottom()
}

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

const activeThread = computed(() => store.threads.find((t) => t.id === store.sessionId))

const activeThreadTitle = computed(() => activeThread.value?.title ?? 'Asistente')

function formatProjectTask(projectId?: string, taskId?: string): string {
  if (!projectId) return 'vista global'
  if (!taskId) return projectId
  const shortTaskId = taskId.length > 10 ? `${taskId.slice(0, 8)}…` : taskId
  return `${projectId} / tareas / ${shortTaskId}`
}

// Dónde estás parado AHORA — sólo se usa como vista previa de un hilo que
// todavía no mandó su primer mensaje (ver `contextPath`): incluye el tab
// porque acá sí importa mostrar toda la ruta, no sólo project/task.
const liveContextPath = computed(() => {
  if (route.name !== 'projects.detail') return 'vista global'
  const projectId = String(route.params.id ?? '')
  if (!projectId) return 'vista global'
  if (context.value.taskId) return formatProjectTask(projectId, context.value.taskId)
  const tab = typeof route.params.tab === 'string' ? route.params.tab : undefined
  return tab ? `${projectId} / ${tab}` : projectId
})

// El contexto de la conversación ACTIVA — una vez que mandó su primer
// mensaje queda fijo (ver `AssistantThread.context` en store.ts), así que
// navegar a otra pantalla mientras la seguís mirando no hace que este
// texto (ni lo que se manda al agente) cambie por debajo. Un hilo sin
// mensajes todavía no tiene nada fijado, así que muestra la vista previa
// en vivo.
const contextPath = computed(() => {
  const pinned = activeThread.value?.context
  if (pinned) return formatProjectTask(pinned.projectId, pinned.taskId)
  return liveContextPath.value
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

// `openInContext` (llamado desde otra feature — una tarea, una ejecución)
// sólo puede sembrar el composer a través del store; `draft` sigue siendo
// local del componente. Se resetea a `null` al consumirlo para que el
// próximo `openInContext` (aunque mande el mismo texto) dispare de nuevo.
watch(
  () => store.draftSeed,
  (seed) => {
    if (seed === null) return
    draft.value = seed
    mobileView.value = 'chat'
    store.draftSeed = null
  },
)

async function scrollToBottom() {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
}

async function selectThread(id: string) {
  mobileView.value = 'chat'
  await store.selectThread(id)
  await scrollToBottom()
}

function startNewThread() {
  store.newThread()
  mobileView.value = 'chat'
}

async function submit() {
  const text = draft.value
  draft.value = ''
  await store.send(text, context.value)
}

/** Clickear una respuesta rápida (```iaflow:choice```) manda su `value`
 *  directo, como si el operador lo hubiese tipeado — no llena el input. */
async function sendChoice(value: string) {
  await store.send(value, context.value)
}
</script>

<template>
  <div class="assistant-bubble">
    <div v-if="store.isOpen" class="drawer">
      <header>
        <button
          v-if="mobileView === 'chat'"
          type="button"
          class="btn-icon back-btn"
          title="Volver a conversaciones"
          @click="mobileView = 'list'"
        >
          ←
        </button>
        <span class="uc-label header-title" :class="{ 'mobile-hide': mobileView === 'chat' }">Asistente</span>
        <span class="uc-label header-title mobile-only-title" v-if="mobileView === 'chat'">{{
          activeThreadTitle
        }}</span>
        <div class="header-actions">
          <button
            type="button"
            class="btn-icon collapse-btn"
            :title="listCollapsed ? 'Mostrar conversaciones' : 'Ocultar conversaciones'"
            @click="toggleListCollapsed"
          >
            {{ listCollapsed ? '»' : '«' }}
          </button>
          <button type="button" class="btn-icon primary" title="Nueva conversación" @click="startNewThread">
            ＋
          </button>
          <button type="button" class="btn-icon" title="Cerrar" @click="store.toggle()">✕</button>
        </div>
      </header>
      <div class="drawer-body" :data-mobile-view="mobileView" :class="{ collapsed: listCollapsed }">
        <nav class="thread-list">
          <div
            v-for="thread in store.threads"
            :key="thread.id"
            class="thread-row"
            :class="{ active: thread.id === store.sessionId }"
          >
            <button type="button" class="thread-select" @click="selectThread(thread.id)">
              <span class="thread-title">{{ thread.title }}</span>
              <span class="thread-meta">{{ formatRelative(thread.updatedAt) }}</span>
            </button>
            <button
              type="button"
              class="thread-delete"
              title="Eliminar conversación"
              @click="deleteTarget = thread.id"
            >
              ✕
            </button>
          </div>
        </nav>
        <div class="chat-pane">
          <div class="context-bar" :title="contextPath">{{ contextPath }}</div>
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
                  <span class="ref-card-title">{{
                    block.type === 'task-card' ? block.title : block.name
                  }}</span>
                  <span v-if="block.type === 'task-card' && block.status" class="ref-card-status">{{
                    block.status
                  }}</span>
                </button>
                <button
                  v-else-if="block.type === 'choice'"
                  type="button"
                  class="choice-chip"
                  :disabled="store.sending"
                  @click="sendChoice(block.value)"
                >
                  {{ block.label }}
                </button>
                <template v-else>{{ block.text }}</template>
              </template>
            </div>
            <div v-if="store.waitingReply" class="message typing">…</div>
          </div>
          <form class="composer" @submit.prevent="submit">
            <input
              v-model="draft"
              type="text"
              placeholder="Escribí un mensaje…"
              :disabled="store.sending"
            />
            <button type="submit" class="btn" :disabled="store.sending || !draft.trim()">Enviar</button>
          </form>
        </div>
      </div>
    </div>
    <button type="button" class="fab" :aria-expanded="store.isOpen" @click="store.toggle()">
      {{ store.isOpen ? '✕' : '💬' }}
    </button>
    <ConfirmDialog
      :open="deleteTarget !== null"
      title="Eliminar conversación"
      message="Se saca de tu lista. El historial sigue en el server, pero perdés el acceso rápido desde acá."
      confirm-label="Eliminar"
      danger
      @cancel="deleteTarget = null"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.assistant-bubble {
  position: fixed;
  inset: auto 0 0 auto;
  z-index: 1100;
}

.fab {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  width: var(--tap-h-lg);
  height: var(--tap-h-lg);
  border-radius: 50%;
  border: 1px solid var(--border-hi);
  background: var(--panel-hi);
  color: var(--fg);
  font-size: 1.2rem;
  cursor: pointer;
  z-index: 1101;
}

.drawer {
  position: fixed;
  inset: 0 0 0 auto;
  width: 100vw;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 32px -16px rgba(0, 0, 0, 0.5);
}

header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-mute);
  background: var(--panel-alt);
  flex-shrink: 0;
}

.header-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.btn-icon.primary {
  color: var(--accent);
}

.back-btn {
  flex-shrink: 0;
}

/* Colapsar la lista de hilos sólo tiene sentido cuando las dos columnas
   conviven (escritorio) — en mobile ya es una pantalla por vez. */
.collapse-btn {
  display: none;
}

.drawer-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* Mobile (<768px, DESIGN_SYSTEM.md): una sola columna por vez — la lista y
   el chat son dos pantallas del mismo sheet, controladas por
   `data-mobile-view`. Arriba del breakpoint las dos se ven siempre. */
.drawer-body[data-mobile-view='list'] .chat-pane {
  display: none;
}

.drawer-body[data-mobile-view='chat'] .thread-list {
  display: none;
}

.mobile-only-title {
  display: block;
}

.header-title.mobile-hide {
  display: none;
}

.thread-list {
  width: 100%;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

/* El borde/fondo del hilo activo vive en la FILA (`.thread-row`), no en
   `.thread-select` — así el botón de borrar queda visualmente adentro de
   la misma tarjeta resaltada en vez de sentarse afuera, en el gap entre
   ambos botones. */
.thread-row {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  padding: 0 0.15rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
}

.thread-row.active {
  background: var(--panel-hi);
  border-color: var(--border-hi);
  box-shadow: inset 2px 0 0 var(--accent);
}

.thread-select {
  flex: 1;
  min-width: 0;
  display: block;
  min-height: var(--tap-h);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.6rem;
  cursor: pointer;
  color: var(--fg);
}

.thread-select:hover {
  background: var(--panel-hi);
}

.thread-delete {
  flex-shrink: 0;
  width: var(--tap-h-sm);
  height: var(--tap-h-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
  border-radius: var(--radius-sm);
  font-size: var(--fs-body-sm);
}

.thread-delete:hover {
  background: var(--panel-hi);
  color: var(--danger);
}

.thread-title {
  display: block;
  font-size: var(--fs-body-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread-meta {
  display: block;
  margin-top: 0.15rem;
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-micro, 0.6875rem);
  color: var(--fg-dim);
}

.chat-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.context-bar {
  flex-shrink: 0;
  padding: 0.3rem 0.75rem;
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-micro, 0.6875rem);
  color: var(--fg-dim);
  background: var(--panel-alt);
  border-bottom: 1px solid var(--border-mute);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

/* Respuesta rápida — a diferencia de `.ref-card` (una fila entera, navega),
   es un chip inline (varias conviven en la misma línea) y no navega: manda
   su `value` como el próximo mensaje. */
.choice-chip {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap-h-sm);
  margin: 0.15rem 0.3rem 0.15rem 0;
  padding: 0.3rem 0.75rem;
  border: 1px solid var(--border-hi);
  border-radius: 999px;
  background: var(--panel);
  color: var(--accent);
  font: inherit;
  font-size: var(--fs-body-sm);
  cursor: pointer;
}

.choice-chip:hover {
  background: var(--panel-hi);
  border-color: var(--accent);
}

.choice-chip:disabled {
  opacity: 0.5;
  cursor: default;
}

.composer {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem;
  border-top: 1px solid var(--border-mute);
  flex-shrink: 0;
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

/* Escritorio: docked, no full-width, y las dos columnas se ven siempre —
   el back button y el título-por-hilo del header móvil desaparecen. */
@media (min-width: 768px) {
  .drawer {
    width: 26rem;
  }

  .back-btn,
  .mobile-only-title {
    display: none;
  }

  .header-title.mobile-hide {
    display: block;
  }

  .collapse-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .drawer-body[data-mobile-view='list'] .chat-pane,
  .drawer-body[data-mobile-view='chat'] .thread-list {
    display: flex;
  }

  .thread-list {
    width: 11rem;
    border-right: 1px solid var(--border-mute);
  }

  /* Colapsada, la columna de hilos desaparece y el chat ocupa todo el
     drawer — la lista sigue viva (no se pierde selección), sólo oculta. */
  .drawer-body.collapsed .thread-list {
    display: none;
  }
}
</style>
