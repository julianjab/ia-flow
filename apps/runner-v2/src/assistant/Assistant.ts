/**
 * El asistente de la web: cada pregunta es un pedido a la capacidad del agente con el que se habla
 * —`assistant`, el de siempre, u otro `assistant.<id>`—, que cumple el agente que la fuente global
 * enchufa (`.config/agents/assistant.yaml`). El runner abre una sesión
 * con el contexto del pedido (`AssistantDesk`) para que las tools del agente lo respeten. La
 * respuesta es la que el agente entrega en `submit_done` (obligatoria): el texto suelto que escriba
 * entre tools es narración y no se muestra — si no, un modelo que cierra sin escribir deja la web
 * vacía, y uno que escribe y además resume, la duplica. La web manda la conversación entera en
 * cada pedido; con el login de GitHub de quien pregunta, además se guarda (`ConversationStore`):
 * la pregunta y la respuesta juntas, sólo si hubo respuesta.
 */
import type { CapabilityInvoker } from '@ia-flow/agent-engine'
import {
  type AssistantAgent,
  type AssistantProposal,
  type AssistantRequest,
  type AssistantScope,
  type AssistantStreamEvent,
  DEFAULT_ASSISTANT_AGENT,
  isIssueProposal,
} from '@ia-flow/shared'
import { createLogger } from '@ia-flow/telemetry'
import { type AssistantDesk, SESSION_KEY } from './AssistantDesk.js'
import { assistantCapability } from './assistantCapability.js'
import { type ConversationStore, conversationTitle } from './ConversationStore.js'

export interface AssistantOptions {
  capabilities: CapabilityInvoker
  desk: AssistantDesk
  /** Dónde se guardan las conversaciones de quien pregunta con login. Sin esto, no se guardan. */
  conversations?: ConversationStore
  /** Los agentes del asistente que declara la config (`assistantAgents`), en vivo. Sin esto,
   *  sólo el de siempre. */
  agents?: () => AssistantAgent[]
}

/** Quién pregunta: con login, el intercambio se guarda a su nombre. */
export interface Asker {
  login?: string
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
    return this.options.desk.connected && this.agents().length > 0
  }

  /** Con quién se puede hablar ahora: los agentes declarados que tienen quién los cumpla. */
  agents(): AssistantAgent[] {
    const declared = this.options.agents?.() ?? [
      { id: DEFAULT_ASSISTANT_AGENT, label: DEFAULT_ASSISTANT_AGENT },
    ]
    return declared.filter((agent) => this.options.capabilities.has(agent.id))
  }

  /** Responde un pedido, emitiendo cada pedazo; no tira: un error sale como evento `error`. */
  async answer(
    request: AssistantRequest,
    emit: (event: AssistantStreamEvent) => void,
    asker: Asker = {},
  ): Promise<void> {
    const agent = request.agent ?? DEFAULT_ASSISTANT_AGENT
    if (!this.agents().some((known) => known.id === agent)) {
      emit({
        type: 'error',
        message:
          agent === DEFAULT_ASSISTANT_AGENT
            ? 'El asistente está apagado: falta `sources.capabilities.assistant` en runner.yaml'
            : `El asistente no tiene el agente "${agent}" (\`sources.capabilities\` en runner.yaml)`,
      })
      return
    }
    const proposals: AssistantProposal[] = []
    const collect = (event: AssistantStreamEvent) => {
      if (event.type === 'proposal') proposals.push(event.proposal)
      emit(event)
    }
    let session: { id: string; close(): void } | undefined
    try {
      session = this.options.desk.open(request.scope, collect)
      const result = await this.options.capabilities.invoke(assistantCapability(agent), {
        session: session.id,
        context: contextText(request.scope),
        history: historyText(request),
        question: request.messages.at(-1)?.content ?? '',
      })
      const answer = result?.answer ?? ''
      emit({ type: 'text', delta: answer })
      // Una tarea con propuesta ya tiene su card (la de la acción): no se repite.
      const proposed = new Set(
        proposals.flatMap((proposal) => (isIssueProposal(proposal) ? [] : [proposal.ref])),
      )
      const tasks = await this.options.desk
        .sessionOf({ [SESSION_KEY]: session.id })
        .resolveTasks((result?.tasks ?? []).filter((ref) => !proposed.has(ref)))
      if (tasks.length > 0) emit({ type: 'tasks', items: tasks })
      const saved = this.save(request, agent, asker, {
        role: 'assistant',
        content: answer,
        proposals,
        tasks: tasks.map((task) => task.ref),
      })
      if (saved) emit({ type: 'conversation', id: saved })
      emit({ type: 'done', text: answer })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log.warn(`el asistente falló: ${message}`)
      emit({ type: 'error', message })
    } finally {
      session?.close()
    }
  }

  /** La pregunta y su respuesta, en la conversación del pedido o en una nueva (también si la del
   *  pedido era con otro agente). Devuelve su id. */
  private save(
    request: AssistantRequest,
    agent: string,
    asker: Asker,
    reply: Parameters<ConversationStore['append']>[1][number],
  ): string | undefined {
    const store = this.options.conversations
    if (!store || !asker.login) return undefined
    const question = request.messages.at(-1)?.content ?? ''
    const id =
      request.conversation_id && store.owns(request.conversation_id, asker.login, agent)
        ? request.conversation_id
        : store.create(asker.login, request.scope, conversationTitle(question), agent)
    store.append(id, [{ role: 'user', content: question, proposals: [], tasks: [] }, reply])
    return id
  }
}
