import { type Action, AllowedAction } from '../pipeline/actions/Action.js'
import type { PipelineExecutionContext } from '../pipeline/Runnable.js'
import type { Tool } from './AgentDefinition.js'

/**
 * Las tools que un agente le da al modelo: las suyas, sus acciones (una que escribe sólo si se
 * habilitó con `allowWrite()`) y las del turno (`submit_*`, `fail_turn`). Cada nombre, una vez.
 */
export class Toolset {
  private readonly actions: Action[]

  constructor(
    private readonly agentId: string,
    private readonly tools: Tool[] = [],
    actions: Array<Action | AllowedAction> = [],
  ) {
    for (const entry of actions) {
      if (entry instanceof AllowedAction || entry.sideEffects !== 'write') continue
      throw new Error(
        `Agent(${agentId}): la acción "${entry.id}" escribe — pasala como ${entry.id}.allowWrite() si el agente puede usarla`,
      )
    }
    this.actions = actions.map((entry) => (entry instanceof AllowedAction ? entry.action : entry))
  }

  /** Los nombres de las tools configuradas (sin las del turno) — lo que queda en la traza. */
  get names(): string[] {
    return [...this.tools.map((tool) => tool.name), ...this.actions.map((action) => action.id)]
  }

  /** Las tools de UNA corrida: las acciones capturan su `ctx`, y se suman las del turno. */
  forRun(ctx: PipelineExecutionContext, turnTools: Tool[]): Tool[] {
    const tools = [...this.tools, ...this.actions.map((action) => action.asTool(ctx)), ...turnTools]
    const seen = new Set<string>()
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new Error(`Agent(${this.agentId}): dos tools con el nombre "${tool.name}"`)
      }
      seen.add(tool.name)
    }
    return tools
  }
}
