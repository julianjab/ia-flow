import type { AssistCallerConfig } from '@ia-flow/shared'

/**
 * Config editable sin redeploy para un caller AD-HOC de `AssistWithAiUseCase`
 * — uno con un `agentId` fijo en código (hoy `task-chat`, `repo-description`)
 * que NO corresponde a un `AgentDefinition` real del engine. Declara "este
 * agentId siempre usa estos system prompts", el equivalente de
 * `AgentDefinition.systemPrompts` para esos callers — ver issue #225.
 *
 * Sin scope por proyecto: un caller ad-hoc es del CÓDIGO (una ruta HTTP fija),
 * no de un proyecto, así que `agent_id` alcanza como clave.
 */
export interface IAssistCallerConfigRepository {
  list(): AssistCallerConfig[]
  getById(agentId: string): AssistCallerConfig | null
  upsert(config: AssistCallerConfig): void
  deleteById(agentId: string): void
}
