/**
 * El asistente de la web: una corrida del provider configurado (`assistant:` de runner.yaml) por
 * pregunta, fuera de toda pipeline — sin ejecución, sin cola, sin board —, con las tools de su
 * contexto. La conversación la guarda la web (el runner no tiene sesión): llega entera en cada
 * pedido. Lo que el modelo escribe sale en vivo (`onText`), y las acciones que propone salen como
 * propuestas para que la persona las confirme.
 */
import { createEvent, type EventBus, type Provider } from '@ia-flow/agent-engine'
import type { AssistantRequest, AssistantScope, AssistantStreamEvent } from '@ia-flow/shared'
import { createLogger } from '@ia-flow/telemetry'
import { type AssistantDeps, assistantTools } from './assistantTools.js'

export interface AssistantOptions {
  /** El provider, resuelto en cada pedido: se registra al servir, después de montar. */
  provider: () => Provider | undefined
  providerId: string
  providerConfig: Record<string, unknown>
  systemPrompt: string
  deps: AssistantDeps
  bus: EventBus
}

/** Cuántos mensajes de la conversación viajan al modelo: los últimos. */
const MAX_TURNS = 12

function scopeText(scope: AssistantScope): string {
  switch (scope.kind) {
    case 'general':
      return 'Contexto de esta conversación: GENERAL — todo el runner y sus proyectos.'
    case 'project':
      return `Contexto de esta conversación: el PROYECTO ${scope.project_id} — sólo sus tareas.`
    case 'task':
      return `Contexto de esta conversación: la TAREA ${scope.ref} — sólo esa tarea.`
  }
}

/** La conversación como texto: el provider recibe un prompt, no turnos. */
function transcript(request: AssistantRequest): string {
  const turns = request.messages.slice(-MAX_TURNS)
  const last = turns.at(-1)
  const history = turns
    .slice(0, -1)
    .map((turn) => `${turn.role === 'user' ? 'Persona' : 'Asistente'}: ${turn.content}`)
  return [
    ...(history.length > 0 ? ['Conversación hasta ahora:', ...history, ''] : []),
    `Pregunta nueva: ${last?.content ?? ''}`,
  ].join('\n')
}

export class Assistant {
  readonly log = createLogger('runner.assistant')

  constructor(private readonly options: AssistantOptions) {}

  get available(): boolean {
    return this.options.provider() !== undefined
  }

  /** Responde un pedido, emitiendo cada pedazo; no tira: un error sale como evento `error`. */
  async answer(
    request: AssistantRequest,
    emit: (event: AssistantStreamEvent) => void,
  ): Promise<void> {
    const provider = this.options.provider()
    if (!provider) {
      emit({
        type: 'error',
        message: `El provider "${this.options.providerId}" no está registrado en este runner`,
      })
      return
    }
    const tools = assistantTools(
      request.scope,
      this.options.deps,
      (proposal) => emit({ type: 'proposal', proposal }),
      (name, summary) => emit({ type: 'tool', name, summary }),
    )
    try {
      const output = await provider.run({
        agentId: 'assistant',
        prompt: transcript(request),
        systemPrompts: [this.options.systemPrompt, scopeText(request.scope)],
        variables: {},
        providerConfig: this.options.providerConfig,
        mcpServers: [],
        tools,
        ctx: {
          event: createEvent('assistant.asked', { scope: request.scope }),
          steps: {},
          bus: this.options.bus,
          pipelineId: 'assistant',
        },
        onText: (delta) => emit({ type: 'text', delta }),
      })
      emit({ type: 'done', text: output.summary ?? '' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log.warn(`el asistente falló: ${message}`)
      emit({ type: 'error', message })
    }
  }
}
