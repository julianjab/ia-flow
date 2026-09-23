import type { Agent } from './Agent.js'

/**
 * Dueño del roster de Agent, indexado por id. Una Rule referencia un agente
 * por agentId (string) y lo resuelve acá en tiempo de ejecución — así un
 * mismo Agent se reusa desde N reglas sin duplicarse (fiel a v1: IAgentRepository
 * + el registry en memoria que arma AgentOrchestrator).
 */
export class AgentRegistry {
  private readonly agents = new Map<string, Agent>()

  register(agent: Agent): void {
    throw new Error(
      'not implemented — this.agents.set(agent.id, agent), rechazar id duplicado. ' +
        'También el punto para validar que agent.exits sea consistente (ninguna clave vacía, ' +
        'output declarado si alguna Rule espera {{steps.<id>.output.<campo>}}) — un exit mal ' +
        'formado tiene que fallar acá, al registrar, no en cada matchExit() de cada run.',
    )
  }

  resolve(id: string): Agent | undefined {
    throw new Error('not implemented — this.agents.get(id)')
  }

  list(): Agent[] {
    throw new Error('not implemented — Array.from(this.agents.values()).sort por position')
  }

  visibleTo(projectId: string | undefined): Agent[] {
    throw new Error('not implemented — agentes con projectId null (global) + los del proyecto')
  }
}
