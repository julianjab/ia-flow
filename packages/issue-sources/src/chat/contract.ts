/** Único status de una sesión de chat — nunca cambia mientras la sesión vive.
 *  `ChatSessionSource.getItems` nunca lo scanea (ver esa clase): sólo la
 *  regla fija del asistente (`on: chat.message`) dispara este agente, con el
 *  agentId ya resuelto — el daemon nunca corre `selectAgent` contra este
 *  status, así que no hay riesgo de que un scan periódico lo re-seleccione. */
export const CHAT_SESSION_STATUS = 'Chatting'

export interface ChatSessionRecord {
  id: string
  projectId?: string
  taskId?: string
  working: boolean
  createdAt: string
}

export interface ChatMessageRecord {
  id: string
  sessionId: string
  /** `'user'` o `'assistant'` — sólo para la UI; el pareo del engine
   *  (`selectCommentWindow`) sigue leyendo el header `# <agentId>` dentro de
   *  `body`, igual que cualquier otro comentario. */
  author: string
  body: string
  createdAt: string
}

/**
 * Persistencia de sesiones de chat, consumida por `ChatSessionSource`/
 * `ChatSessionTaskSource`. Async y declarada acá (no importada de
 * `apps/server`) — mismo patrón que `ITaskRepository`: el paquete no puede
 * depender hacia afuera, así que el server implementa esta forma
 * estructuralmente (`SqliteChatSessionRepository` + un adaptador fino en
 * `composition/container.ts`).
 */
export interface ChatSessionStore {
  getById(id: string): Promise<ChatSessionRecord | null>
  ensure(id: string, opts?: { projectId?: string; taskId?: string }): Promise<ChatSessionRecord>
  setWorking(id: string, working: boolean): Promise<void>
  listMessages(sessionId: string): Promise<ChatMessageRecord[]>
  appendMessage(sessionId: string, author: string, body: string): Promise<ChatMessageRecord>
}
