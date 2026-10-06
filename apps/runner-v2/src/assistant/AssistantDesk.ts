/**
 * Donde las actions del agente `assistant` encuentran el pedido que las está usando: el runner abre
 * una sesión por pedido (con su contexto y a dónde mandar lo que pasa) y le pasa el id al agente
 * en el payload de la capacidad. Las actions se arman una sola vez, al leer el YAML; la sesión es
 * lo que cambia en cada pedido.
 *
 * Un agente que corre en la pipeline de una tarea (la retrospectiva) usa las mismas tools sin
 * pedido: su sesión es la de esa tarea, la arma `sessionFor` con el evento, y lo que propone queda
 * en la bandeja.
 *
 * Va en los `services` de las actions desde que el runner monta, y se conecta a la bandeja al
 * servir (`inbox/mountInbox.ts`): sin eso, el asistente no tiene qué leer.
 */
import type { PipelineExecutionContext } from '@ia-flow/agent-engine'
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

  /**
   * La sesión de quien llama una tool: el pedido al asistente que corre `ctx` (su payload trae el
   * id), o —un agente en la pipeline de una tarea— una de esa tarea (`task.id` del evento), a
   * nombre de `agent`.
   */
  sessionFor(ctx: PipelineExecutionContext, agent: string | undefined): AssistantSession {
    const payload = (ctx.event.payload ?? {}) as Record<string, unknown>
    if (SESSION_KEY in payload) return this.sessionOf(payload)
    const ref = (payload.task as { id?: unknown } | undefined)?.id
    if (typeof ref !== 'string') {
      throw new Error(
        'esta tool sólo funciona dentro de un pedido al asistente o en la pipeline de una tarea',
      )
    }
    if (!this.backend) throw new Error('el asistente no está conectado a la bandeja (--serve)')
    const pr = (payload.pr as { url?: unknown } | undefined)?.url
    return new AssistantSession({ kind: 'task', ref }, this.backend, () => {}, {
      agent: agent ?? 'pipeline',
      ...(ctx.execution ? { execution_id: ctx.execution.id } : {}),
      ...(typeof pr === 'string' ? { pr_url: pr } : {}),
    })
  }
}
