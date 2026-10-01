/**
 * Donde las actions del agente `assistant` encuentran el pedido que las está usando: el runner abre
 * una sesión por pedido (con su contexto y a dónde mandar lo que pasa) y le pasa el id al agente
 * en el payload de la capacidad. Las actions se arman una sola vez, al leer el YAML; la sesión es
 * lo que cambia en cada pedido.
 *
 * Va en los `services` de las actions desde que el runner monta, y se conecta a la bandeja al
 * servir (`inbox/mountInbox.ts`): sin eso, el asistente no tiene qué leer.
 */
import type { AssistantScope, AssistantStreamEvent } from '@ia-flow/shared'
import { type AssistantBackend, AssistantSession } from './AssistantSession.js'

/** La clave del payload de la capacidad con el id de la sesión. */
export const SESSION_KEY = 'session'

export class AssistantDesk {
  private backend?: AssistantBackend
  private readonly sessions = new Map<string, AssistantSession>()

  connect(backend: AssistantBackend): void {
    this.backend = backend
  }

  get connected(): boolean {
    return this.backend !== undefined
  }

  /** Abre la sesión de un pedido; `close` la olvida. */
  open(
    scope: AssistantScope,
    emit: (event: AssistantStreamEvent) => void,
  ): { id: string; close(): void } {
    if (!this.backend) throw new Error('el asistente no está conectado a la bandeja (--serve)')
    const id = globalThis.crypto.randomUUID()
    this.sessions.set(id, new AssistantSession(scope, this.backend, emit))
    return { id, close: () => this.sessions.delete(id) }
  }

  /** La sesión del pedido que corre `payload` (el de la capacidad). */
  sessionOf(payload: unknown): AssistantSession {
    const id = (payload as Record<string, unknown> | undefined)?.[SESSION_KEY]
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined
    if (!session) throw new Error('esta tool sólo funciona dentro de un pedido al asistente')
    return session
  }
}
