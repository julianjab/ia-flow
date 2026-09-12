import type { CommentTarget, Task } from '@ia-flow/shared'
import type { BroadcastFn, TaskSource } from '../contract.js'
import { CHAT_SESSION_STATUS, type ChatSessionStore } from './contract.js'

/**
 * El lado de escritura de una sesión de chat. Sólo lo mínimo que
 * `ITaskSource` exige (`applyTransition`/`saveOutput`/`setAgentWorking`) más
 * `postComment` — el canal de respuesta del asistente, igual que cualquier
 * otro agente del engine (ver "Comentarios" en el CLAUDE.md raíz: ningún
 * agente escribe su reporte por fuera de este mecanismo). Nótese que NO
 * agrega el marker `<!-- ia-flow:system-comment -->` que sí usan los
 * `TaskSource` de GitHub — a propósito: sin él, `selectCommentWindow`
 * (`@ia-flow/issue-sources`) nunca reconoce un comentario propio y devuelve
 * SIEMPRE la conversación completa (ver su doc: "sin comentario propio
 * devuelve la lista entera") — es lo que le da memoria multi-turno al
 * asistente sin necesitar `pause_until`/checkpoints.
 */
export class ChatSessionTaskSource implements TaskSource {
  constructor(
    private store: ChatSessionStore,
    private broadcast: BroadcastFn,
  ) {}

  // Una sesión de chat tiene un único status — no hay a dónde transicionar.
  async applyTransition(task: Task): Promise<Task> {
    return { ...task, status: CHAT_SESSION_STATUS }
  }

  // No aplica: en otros sources `saveOutput` reemplaza el body del issue; acá
  // el canal de respuesta es `postComment`.
  async saveOutput(task: Task): Promise<Task> {
    return task
  }

  async setAgentWorking(task: Task, working: boolean): Promise<Task> {
    await this.store.setWorking(task.id, working)
    return { ...task, agent_working: working }
  }

  async postComment(task: Task, body: string, target?: CommentTarget): Promise<void> {
    // `none` no tiene un destino alternativo acá — mismo criterio que
    // local-fs: la única forma de respetarlo es no escribir nada.
    if (target === 'none') return
    const message = await this.store.appendMessage(task.id, 'assistant', body)
    // Lo que hace que el widget web reciba la respuesta sin poll — mismo
    // canal WS que ya usa el resto de la app.
    this.broadcast({
      type: 'assistant:message',
      sessionId: task.id,
      author: message.author,
      body: message.body,
      createdAt: message.createdAt,
    })
  }

  async getCurrentStatus(): Promise<string | null> {
    return CHAT_SESSION_STATUS
  }
}
