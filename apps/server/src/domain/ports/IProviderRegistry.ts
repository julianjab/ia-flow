import type { IAgentProvider } from './IAgentProvider.js'

export interface IProviderRegistry {
  register(provider: IAgentProvider): void
  get(id: string): IAgentProvider
  list(): IAgentProvider[]
}
