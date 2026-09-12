import type { AssistantChatMessage } from '@ia-flow/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useToastStore } from '@/stores/toast'
import { fetchAssistantMessages, postAssistantMessage } from './api.js'

/** El contexto automático (proyecto/tarea activos) que viaja con un mensaje
 *  — ver `AssistantBubble.vue`. */
export interface AssistantContext {
  projectId?: string
  taskId?: string
}

/** Metadata de una conversación — el historial en sí vive del lado del
 *  server (chat_messages, por sessionId); esto es sólo lo que hace falta
 *  para dibujar la lista y no perderla al cerrar el browser.
 *
 *  `context` se graba una sola vez, con el primer mensaje — a propósito NO
 *  se actualiza con la ruta activa en cada visita: si el operador tiene
 *  esta conversación abierta y navega a otra pantalla sólo para mirar algo,
 *  el contexto de la conversación (y lo que se manda al agente en su
 *  próximo turno) no debería cambiarse solo por eso. `undefined` = todavía
 *  sin mensajes, así que no hay nada que fijar aún. */
export interface AssistantThread {
  id: string
  title: string
  updatedAt: string
  context?: AssistantContext
}

const THREADS_KEY = 'ia-flow:assistant:threads'
const MAX_TITLE_LENGTH = 48

function newSessionId(): string {
  return crypto.randomUUID()
}

function truncateTitle(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_TITLE_LENGTH ? `${trimmed.slice(0, MAX_TITLE_LENGTH - 1)}…` : trimmed
}

function loadThreads(): AssistantThread[] {
  try {
    const raw = localStorage.getItem(THREADS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is AssistantThread =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as AssistantThread).id === 'string' &&
        typeof (t as AssistantThread).title === 'string' &&
        typeof (t as AssistantThread).updatedAt === 'string',
    )
  } catch {
    return []
  }
}

function saveThreads(threads: AssistantThread[]) {
  try {
    localStorage.setItem(THREADS_KEY, JSON.stringify(threads))
  } catch {
    // Storage bloqueado (modo privado, cuota) — perder la lista de hilos
    // entre sesiones del browser es aceptable; no es un error visible.
  }
}

export const useAssistantStore = defineStore('assistant', () => {
  const isOpen = ref(false)
  const threads = ref<AssistantThread[]>(loadThreads())
  if (!threads.value.length) {
    threads.value = [
      { id: newSessionId(), title: 'Nueva conversación', updatedAt: new Date().toISOString() },
    ]
    saveThreads(threads.value)
  }
  const sessionId = ref(threads.value[0].id)
  const messages = ref<AssistantChatMessage[]>([])
  const sending = ref(false)
  // `true` mientras se espera la respuesta del agente por WS — no hay un
  // "terminó" explícito del lado del server (es fire-and-forget), así que se
  // apaga en cuanto llega CUALQUIER mensaje del asistente para esta sesión.
  const waitingReply = ref(false)

  const hasMessages = computed(() => messages.value.length > 0)
  // Más reciente primero — es el orden en que se listan los hilos.
  const sortedThreads = computed(() =>
    [...threads.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  )

  function toggle() {
    isOpen.value = !isOpen.value
  }

  /** Actualiza (o crea, si no existía) la fila de un hilo y persiste la
   *  lista — único punto de escritura de `threads`, para no repetir el
   *  try/catch de `localStorage` en cada llamador. `context` sólo se aplica
   *  cuando el llamador lo pasa explícitamente (ver `send()` — se fija una
   *  sola vez, con el primer mensaje). */
  function touchThread(id: string, title?: string, context?: AssistantContext) {
    const updatedAt = new Date().toISOString()
    const existing = threads.value.find((t) => t.id === id)
    if (existing) {
      existing.updatedAt = updatedAt
      if (title) existing.title = title
      if (context) existing.context = context
    } else {
      threads.value = [
        ...threads.value,
        { id, title: title ?? 'Nueva conversación', updatedAt, context },
      ]
    }
    saveThreads(threads.value)
  }

  async function hydrate() {
    try {
      messages.value = await fetchAssistantMessages(sessionId.value)
    } catch {
      // Sesión nueva o server sin historial todavía — no es un error visible.
      messages.value = []
    }
  }

  /** Cambia de conversación activa e hidrata su historial — las demás
   *  siguen vivas del lado del server, no se pierden. */
  async function selectThread(id: string) {
    if (id === sessionId.value) return
    sessionId.value = id
    waitingReply.value = false
    await hydrate()
  }

  /** Arranca una conversación nueva y la deja activa. */
  function newThread() {
    sessionId.value = newSessionId()
    messages.value = []
    waitingReply.value = false
    touchThread(sessionId.value)
  }

  async function send(text: string, ctx: AssistantContext = {}) {
    const trimmed = text.trim()
    if (!trimmed || sending.value) return
    sending.value = true
    waitingReply.value = true
    // Optimista: el mensaje del operador se ve al toque, no espera al
    // roundtrip — la ruta lo persiste igual del lado del server.
    const optimisticId = crypto.randomUUID()
    messages.value = [
      ...messages.value,
      {
        id: optimisticId,
        sessionId: sessionId.value,
        author: 'user',
        body: trimmed,
        createdAt: new Date().toISOString(),
      },
    ]
    // El contexto se fija con el primer mensaje y de ahí en más gana sobre
    // el de la ruta activa — evita que navegar a otra pantalla mientras la
    // conversación sigue abierta le cambie el tema por debajo (ver el
    // comment de `AssistantThread.context`).
    const pinnedContext = threads.value.find((t) => t.id === sessionId.value)?.context
    const effectiveCtx = pinnedContext ?? ctx
    // El primer mensaje de la conversación le pone título al hilo en la
    // lista — antes de eso sólo tiene el placeholder "Nueva conversación".
    touchThread(
      sessionId.value,
      messages.value.length === 1 ? truncateTitle(trimmed) : undefined,
      pinnedContext ? undefined : ctx,
    )
    try {
      await postAssistantMessage({ sessionId: sessionId.value, text: trimmed, ...effectiveCtx })
    } catch (err) {
      // El POST falló — nunca llegó a publicarse el evento, así que no hay
      // respuesta que esperar y el mensaje optimista miente sobre lo que el
      // server tiene. Revertir los dos evita un "…" colgado para siempre.
      messages.value = messages.value.filter((m) => m.id !== optimisticId)
      waitingReply.value = false
      useToastStore().error('No se pudo enviar el mensaje. Probá de nuevo.')
      console.error('assistant: send failed', err)
    } finally {
      sending.value = false
    }
  }

  /** Saca un hilo de la lista — sólo el puntero local, el historial en
   *  `chat_messages` no se toca (ver el diseño de esta feature: las
   *  conversaciones viejas ya envejecen solas del lado del server). Si era
   *  el hilo activo, cae al más reciente que quede o arranca uno nuevo si
   *  no quedó ninguno. */
  async function deleteThread(id: string) {
    const wasActive = id === sessionId.value
    threads.value = threads.value.filter((t) => t.id !== id)
    saveThreads(threads.value)
    if (!wasActive) return
    const next = sortedThreads.value[0]
    if (next) {
      sessionId.value = next.id
      waitingReply.value = false
      await hydrate()
    } else {
      newThread()
    }
  }

  /** Llamado desde el listener de WS (ver AssistantBubble.vue) cuando llega
   *  `assistant:message` — de cualquier hilo conocido, no sólo el activo,
   *  para que su fila en la lista refleje la actividad aunque no lo estés
   *  mirando ahora mismo. */
  function receive(message: AssistantChatMessage) {
    touchThread(message.sessionId)
    if (message.sessionId !== sessionId.value) return
    messages.value = [...messages.value, message]
    waitingReply.value = false
  }

  return {
    isOpen,
    sessionId,
    threads: sortedThreads,
    messages,
    sending,
    waitingReply,
    hasMessages,
    toggle,
    hydrate,
    selectThread,
    newThread,
    deleteThread,
    send,
    receive,
  }
})
