import {
  type ProviderInfo,
  type UpdateProviderConfigBody,
  getProviders,
  updateProviderConfig,
} from '@/features/providers/api'
import type { ProviderConfig, StepType } from '@ia-flow/shared'
import axios from 'axios'
import { defineStore } from 'pinia'

// Re-exports so components can import types from this module.
export type { ProviderConfig, AnthropicApiSettings, ItermClaudeSettings } from '@ia-flow/shared'
export type StepId = StepType
export type ProviderId = string
export type Provider = ProviderInfo
export type ProviderConfigPatch = Partial<UpdateProviderConfigBody>

interface State {
  providers: ProviderInfo[]
  config: ProviderConfig | null
  githubProjectUrl: string | null
  loading: boolean
  saving: boolean
  error: string | null
}

const STEPS_LIST: StepType[] = ['refine-functional', 'refine-technical', 'implement']

function extractError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string; message?: string } | undefined
    return data?.error ?? data?.message ?? err.message
  }
  if (err instanceof Error) return err.message
  return 'Unknown error'
}

export const useProvidersStore = defineStore('providers', {
  state: (): State => ({
    providers: [],
    config: null,
    githubProjectUrl: null,
    loading: false,
    saving: false,
    error: null,
  }),
  getters: {
    stepsList: (): StepType[] => STEPS_LIST,
  },
  actions: {
    async fetchConfig() {
      this.loading = true
      this.error = null
      try {
        const { providers, config, githubProjectUrl } = await getProviders()
        this.providers = providers
        this.config = config
        this.githubProjectUrl = githubProjectUrl
      } catch (err) {
        this.error = extractError(err)
      } finally {
        this.loading = false
      }
    },
    async saveConfig(patch: UpdateProviderConfigBody) {
      this.saving = true
      this.error = null
      try {
        const config = await updateProviderConfig(patch)
        this.config = config
      } catch (err) {
        this.error = extractError(err)
      } finally {
        this.saving = false
      }
    },
  },
})
