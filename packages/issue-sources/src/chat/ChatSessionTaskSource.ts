import type { CommentTarget, Task } from '@ia-flow/shared'
import type { TaskSource } from '../contract.js'
import { CHAT_SESSION_STATUS, type ChatSessionStore } from './contract.js'

/**
 * El lado de escritura de una sesión de chat. Sólo lo mínimo que
 * `ITaskSource` exige (`applyTransition`/`saveOutput`/`setAgentWorking`) más
 * `postComment` — el canal de respuesta del asistente, igual que cualquier
 * otro agente del engine (ver "Comentarios" en el CLAUDE.md raíz: ningún
 * agente escribe su reporte por fuera de este mecanismo).
 */
export class ChatSessionTaskSource implements TaskSource {
  constructor(private store: ChatSessionStore) {}

  // Una sesión de chat tiene un único status — no hay a dónde transicionar.
  // El agente "termina" un turno con `pause_until`, nunca con un exit que
  // mueva status (ver el diseño de esta feature).
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
    await this.store.appendMessage(task.id, 'assistant', body)
  }

  async getCurrentStatus(): Promise<string | null> {
    return CHAT_SESSION_STATUS
  }
}
