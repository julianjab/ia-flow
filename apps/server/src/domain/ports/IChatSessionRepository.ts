export interface ChatSession {
  id: string
  projectId?: string
  taskId?: string
  working: boolean
  createdAt: string
}

export interface ChatMessage {
  id: string
  sessionId: string
  /** `'user'` o el `agentId` que respondió. Sólo para distinguir en la UI —
   *  el pareo con `selectCommentWindow` sigue leyendo el header `# <agentId>`
   *  dentro de `body`, igual que cualquier otro comentario del engine. */
  author: string
  body: string
  createdAt: string
}

/**
 * Persistencia del asistente conversacional — ver `ChatSessionSource`
 * (`@ia-flow/issue-sources`), que es el único consumidor. Angosto a
 * propósito: sólo lo que una sesión de chat necesita, sin nada de lógica de
 * negocio (eso vive en el `ProjectSource`/`TaskSource` que envuelve esto).
 */
export interface IChatSessionRepository {
  getById(id: string): ChatSession | null
  /** Crea la sesión si no existe todavía. Si ya existe, actualiza
   *  `projectId`/`taskId` con lo que traiga `opts` — "último mensaje gana":
   *  es lo que hace que el contexto refleje dónde está el operador AHORA,
   *  no dónde estaba cuando arrancó la sesión. */
  ensure(id: string, opts?: { projectId?: string; taskId?: string }): ChatSession
  setWorking(id: string, working: boolean): void
  listMessages(sessionId: string): ChatMessage[]
  appendMessage(sessionId: string, author: string, body: string): ChatMessage
}
