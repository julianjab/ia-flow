import type { StepProvider } from './types.js'

// Module-level registry of step providers keyed by id. Distinct from the
// hexagonal ProviderRegistry (infrastructure/providers/ProviderRegistry.ts)
// which speaks IAgentProvider — the two shapes differ, so this legacy
// registry stays until every caller migrates to the new port.
const providers = new Map<string, StepProvider>()

export function registerProvider(p: StepProvider): void {
  providers.set(p.id, p)
}

export function getProvider(id: string): StepProvider {
  const p = providers.get(id)
  if (!p) {
    throw new Error(
      `Provider '${id}' not registered. Available: ${[...providers.keys()].join(', ')}`,
    )
  }
  return p
}

export function listProviders(): StepProvider[] {
  return [...providers.values()]
}
