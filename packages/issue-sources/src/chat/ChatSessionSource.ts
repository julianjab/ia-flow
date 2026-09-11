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
import { CHAT_SESSION_STATUS, type ChatSessionStore } from './contract.js'

function toSourceItem(id: string, title: string): SourceItem {
  return { id, title, status: CHAT_SESSION_STATUS }
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
    return toSourceItem(id, title)
  }

  getTransitionManager(_item: IssueItem, _broadcast: BroadcastFn): TaskSource {
    return new ChatSessionTaskSource(this.store)
  }

  async loadComments(item: IssueItem): Promise<TaskComment[]> {
    const messages = await this.store.listMessages(item.id)
    return messages.map((m) => ({ body: m.body, created_at: m.createdAt }))
  }

  // Sin polling propio: el disparo es 100% por evento (`chat.message`),
  // nunca por scan — ver el comentario de la clase.
  watch(_onItems: (items: SourceItem[]) => void, _opts: WatchOptions): Disposable {
    return { dispose: () => {} }
  }
}
