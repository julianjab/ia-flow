import type { StepType } from '@ia-flow/shared'

export interface IPromptRepository {
  getPhasePrompt(step: StepType): string | null
  setPhasePrompt(step: StepType, prompt: string): void
  getUtilityPrompt(key: string): string | null
  setUtilityPrompt(key: string, prompt: string): void
  getProviderConfigBlob(): Record<string, unknown> | null
  setProviderConfigBlob(config: Record<string, unknown>): void
  deleteProviderConfigBlob(): void
}
