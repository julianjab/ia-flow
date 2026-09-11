import type { IProjectConfigRepository } from '@ia-flow/agent-engine'
import type { AgentDefinition } from '@ia-flow/shared'

/**
 * Decora `IProjectConfigRepository.getConfig` para inyectar los agentes
 * intrínsecos del engine (`base-agents.yaml`) en el `config.agents` del
 * proyecto reservado del asistente — sin que salgan de la DB ni sean
 * editables desde el editor de agentes. Ver `apps/server/src/system-agents/`.
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
