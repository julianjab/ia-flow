/**
 * El asistente de la web: cada pregunta es un pedido a la capacidad `assistant`, que cumple el
 * agente que la fuente global enchufa (`.config/agents/assistant.yaml`). El runner abre una sesión
 * con el contexto del pedido (`AssistantDesk`) para que las tools del agente lo respeten, y
 * streamea lo que el modelo escribe. La conversación la guarda la web: llega entera en cada pedido.
 */
import type { CapabilityInvoker } from '@ia-flow/agent-engine'
import type { AssistantRequest, AssistantScope, AssistantStreamEvent } from '@ia-flow/shared'
import { createLogger } from '@ia-flow/telemetry'
import type { AssistantDesk } from './AssistantDesk.js'
import { ASSISTANT } from './assistantCapability.js'

export interface AssistantOptions {
  capabilities: CapabilityInvoker
  desk: AssistantDesk
}

/** Cuántos mensajes de la conversación viajan al modelo: los últimos. */
const MAX_TURNS = 12

function contextText(scope: AssistantScope): string {
  switch (scope.kind) {
    case 'general':
      return 'GENERAL: todo el runner y sus proyectos.'
    case 'project':
      return `el PROYECTO ${scope.project_id}: sólo sus tareas.`
    case 'task':
      return `la TAREA ${scope.ref}: sólo esa tarea.`
  }
}

function historyText(request: AssistantRequest): string {
  return request.messages
    .slice(-MAX_TURNS, -1)
    .map((turn) => `${turn.role === 'user' ? 'Persona' : 'Asistente'}: ${turn.content}`)
    .join('\n')
}

export class Assistant {
  readonly log = createLogger('runner.assistant')

  constructor(private readonly options: AssistantOptions) {}

  /** Si hay un agente enchufado a la capacidad y una bandeja de donde leer. */
  get available(): boolean {
    return this.options.desk.connected && this.options.capabilities.has(ASSISTANT.name)
  }

  /** Responde un pedido, emitiendo cada pedazo; no tira: un error sale como evento `error`. */
  async answer(
    request: AssistantRequest,
    emit: (event: AssistantStreamEvent) => void,
  ): Promise<void> {
    if (!this.options.capabilities.has(ASSISTANT.name)) {
      emit({
        type: 'error',
        message: 'El asistente está apagado: falta `sources.capabilities.assistant` en runner.yaml',
      })
      return
    }
    let streamed = ''
    let session: { id: string; close(): void } | undefined
    try {
      session = this.options.desk.open(request.scope, emit)
      const result = await this.options.capabilities.invoke(
        ASSISTANT,
        {
          session: session.id,
          context: contextText(request.scope),
          history: historyText(request),
          question: request.messages.at(-1)?.content ?? '',
        },
        {
          onText: (delta) => {
            streamed += delta
            emit({ type: 'text', delta })
          },
        },
      )
      // Un modelo que dejó la respuesta en `submit_done` y no como texto: igual se ve.
      const answer = result?.answer?.trim()
      if (answer && !streamed.includes(answer)) {
        const delta = `${streamed ? '\n\n' : ''}${answer}`
        streamed += delta
        emit({ type: 'text', delta })
      }
      emit({ type: 'done', text: streamed })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log.warn(`el asistente falló: ${message}`)
      emit({ type: 'error', message })
    } finally {
      session?.close()
    }
  }
}
