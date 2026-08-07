import type {
  AnthropicApiSettings,
  ProviderConfig,
  RepoMapping,
  TerminalProviderSettings,
} from '@ia-flow/shared'
import axios from 'axios'

export interface ProviderInfo {
  id: string
  name: string
  description: string
}

export interface ProvidersResponse {
  providers: ProviderInfo[]
  config: ProviderConfig
  githubProjectUrl: string | null
}

export interface UpdateProviderConfigBody {
  steps: ProviderConfig['steps']
  anthropicApi: AnthropicApiSettings
  tmuxClaude?: TerminalProviderSettings
  itermClaude?: TerminalProviderSettings
  repoMappings?: RepoMapping
  providerCallbacks?: Record<string, Array<{ name: string; text: string }>>
}

export async function getProviders(): Promise<ProvidersResponse> {
  const { data } = await axios.get<ProvidersResponse>('/api/providers')
  return data
}

export async function updateProviderConfig(
  body: UpdateProviderConfigBody,
): Promise<ProviderConfig> {
  const { data } = await axios.put<ProviderConfig>('/api/providers/config', body)
  return data
}
