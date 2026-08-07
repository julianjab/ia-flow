import type { ITool } from './ITool.js'

export interface IToolRegistry {
  register(tool: ITool): void
  get(name: string): ITool | undefined
  list(): ITool[]
  buildToolInstructions(
    toolNames: string[] | undefined,
    providerId: string,
    daemonUrl: string,
    taskId: string,
  ): string
}
