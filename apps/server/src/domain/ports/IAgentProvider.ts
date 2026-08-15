// Re-exported from @ia-flow/ai-providers, where the contract now lives
// (packages/ai-providers/src/contract.ts). Kept as a narrow re-export so the
// many existing `domain/ports/IAgentProvider.js` importers across
// apps/server don't need to change their import path as part of the
// extraction.
export type {
  IAgentProvider,
  ProviderInput,
  ProviderOutput,
  ProviderKind,
  SessionHandle,
} from '@ia-flow/ai-providers'
