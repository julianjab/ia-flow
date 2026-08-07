import type { IAgentProvider } from '../../domain/ports/IAgentProvider.js'
import type { IProviderRegistry } from '../../domain/ports/IProviderRegistry.js'

export class ProviderRegistry implements IProviderRegistry {
  private map = new Map<string, IAgentProvider>()

  register(p: IAgentProvider): void {
    this.map.set(p.id, p)
  }

  get(id: string): IAgentProvider {
    const p = this.map.get(id)
    if (!p) {
      throw new Error(
        `Provider '${id}' not registered. Available: ${[...this.map.keys()].join(', ')}`,
      )
    }
    return p
  }

  list(): IAgentProvider[] {
    return [...this.map.values()]
  }
}
