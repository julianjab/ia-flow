import type { IAgentProvider } from './IAgentProvider.js'
import type { ITool } from './ITool.js'

export interface IToolRegistry {
  register(tool: ITool): void
  get(name: string): ITool | undefined
  list(): ITool[]
  /**
   * Returns the markdown appendix that async providers append to the agent's
   * prompt so the model can call each available tool via `curl`. Sync
   * providers get an empty string — they expose tools natively via the API.
   */
  buildToolInstructions(
    toolNames: string[] | undefined,
    provider: Pick<IAgentProvider, 'id' | 'kind'>,
    daemonUrl: string,
    taskId: string,
    opts?: { disabledTools?: string[] },
  ): string
}
