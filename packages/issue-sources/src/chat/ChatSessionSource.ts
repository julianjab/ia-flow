import type { TaskComment } from '@ia-flow/shared'
import type {
  BroadcastFn,
  Disposable,
  IssueItem,
  ProjectSource,
  SourceItem,
  StatusOption,
  TaskSource,
  WatchOptions,
} from '../contract.js'
import { ChatSessionTaskSource } from './ChatSessionTaskSource.js'
import { CHAT_SESSION_STATUS, type ChatSessionRecord, type ChatSessionStore } from './contract.js'

/**
 * `meta.description` es lo único que hace que el contexto de dónde estaba
 * parado el operador (`projectId`/`taskId`, capturados por
 * `routes/assistant-chat.ts` en cada mensaje) le llegue al agente:
 * `defaultToIssueItem` lo copia a `IssueItem.description`, que es lo que
 * `{{task.description}}` renderiza en el prompt — sin esto, el "contexto
 * automático" del bubble button no tiene forma de llegar al modelo.
 */
function describeContext(session: ChatSessionRecord): string {
  if (!session.projectId && !session.taskId) {
    return 'El operador está en una vista global (sin proyecto/tarea activos).'
  }
  const parts = [`Proyecto activo: ${session.projectId ?? '(ninguno)'}`]
  if (session.taskId) parts.push(`Tarea activa: ${session.taskId}`)
  return parts.join('. ')
}

function toSourceItem(session: ChatSessionRecord, title: string): SourceItem {
  return {
    id: session.id,
    title,
    status: CHAT_SESSION_STATUS,
    meta: { description: describeContext(session) },
  }
}

/**
 * Una sesión de chat, modelada como un `ProjectSource` más — mismo mecanismo
 * que cualquier board real (GitHub, local-fs): sus "issues" son sesiones de
 * conversación y sus "comentarios" los mensajes de usuario/agente, lo que
 * hace que `{{task.comments}}` y el resto del prompt-builder funcionen sin
 * cambios.
 *
 * `getItems`/`watch` devuelven vacío/no-op a propósito: desde la migración
 * 059 el "cuándo corre un agente" vive enteramente en `rules` (un
 * `AgentDefinition` ya no declara activación), así que el daemon no tiene
 * ningún scan automático que decida por su cuenta correr el asistente sobre
 * una sesión — el único disparador posible es la regla fija `on:
 * chat.message` (ver `apps/server/src/system-agents/`), con el `IssueItem`
 * ya resuelto en el payload del evento. `getItemById` existe como respaldo
 * para ese camino, no como uno que el daemon recorra solo.
 */
export class ChatSessionSource implements ProjectSource {
  readonly kind = 'chat-session'

  constructor(private store: ChatSessionStore) {}

  async getStatuses(): Promise<StatusOption[]> {
    return [{ name: CHAT_SESSION_STATUS }]
  }

  // Las sesiones de chat no aparecen en ningún board ni las escanea el
  // daemon (ver el comentario de la clase) — `getItems` existe sólo porque
  // `ProjectSource` lo declara obligatorio.
  async getItems(): Promise<SourceItem[]> {
    return []
  }

  async getItemById(id: string): Promise<SourceItem | null> {
    const session = await this.store.getById(id)
    if (!session) return null
    const messages = await this.store.listMessages(id)
    const title = messages[0]?.body?.slice(0, 80) || `Chat ${id}`
    return toSourceItem(session, title)
  }

  getTransitionManager(_item: IssueItem, broadcast: BroadcastFn): TaskSource {
    return new ChatSessionTaskSource(this.store, broadcast)
  }

  async loadComments(item: IssueItem): Promise<TaskComment[]> {
    const messages = await this.store.listMessages(item.id)
    // `author` es lo único que distingue "user" de "assistant" en el prompt
    // renderizado (`formatComments`, apps/server/src/variables/task.ts) — sin
    // esto, a partir del 2º turno el modelo ve una lista plana donde sus
    // propias respuestas y los mensajes del operador son indistinguibles.
    return messages.map((m) => ({ body: m.body, created_at: m.createdAt, author: m.author }))
  }

  // Sin polling propio: el disparo es 100% por evento (`chat.message`),
  // nunca por scan — ver el comentario de la clase.
  watch(_onItems: (items: SourceItem[]) => void, _opts: WatchOptions): Disposable {
    return { dispose: () => {} }
  }
}
