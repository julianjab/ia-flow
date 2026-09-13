import type { IProjectConfigRepository } from '@ia-flow/agent-engine'
import type { AgentDefinition } from '@ia-flow/shared'

/**
 * Decora `IProjectConfigRepository.getConfig` para inyectar los agentes
 * intrínsecos del engine (`base-agents.yaml`) en el `config.agents` que ve
 * `CHAT_PROJECT_ID` — sin que salgan de la DB ni sean editables desde el
 * editor de agentes. `CHAT_PROJECT_ID` NO es un `Project` real (no hay fila
 * en `projects`); es sólo la clave de scope que usa este decorador y
 * `managerFor` (`composition/actions.ts`) para reconocer al asistente. Ver
 * `apps/server/src/system-agents/`.
 *
 * Mismo patrón decorador que `BroadcastingExecutionLogRepository`/
 * `CompositeExecutionLogRepository`: envuelve el repo real en
 * `composition/container.ts`, así que todo consumidor de `configRepo`
 * (rutas, `AgentOrchestrator`, `TaskDispatcher`) ve el agente sin tocar su
 * propio código.
 */
export class SystemAgentProjectConfigRepository implements IProjectConfigRepository {
  constructor(
    private inner: IProjectConfigRepository,
    private chatProjectId: string,
    private baseAgents: AgentDefinition[],
  ) {}

  async getConfig(scope?: string | null) {
    const config = await this.inner.getConfig(scope)
    if (scope !== this.chatProjectId || !this.baseAgents.length) return config
    return { ...config, agents: [...(config.agents ?? []), ...this.baseAgents] }
  }
}
