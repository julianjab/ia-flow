import axios from 'axios';
import type { ProviderConfig, AnthropicApiSettings } from '@ia-flow/shared';

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  config: ProviderConfig;
}

export interface UpdateProviderConfigBody {
  steps: ProviderConfig['steps'];
  anthropicApi: AnthropicApiSettings;
}

export async function getProviders(): Promise<ProvidersResponse> {
  const { data } = await axios.get<ProvidersResponse>('/api/providers');
  return data;
}

export async function updateProviderConfig(
  body: UpdateProviderConfigBody,
): Promise<ProviderConfig> {
  const { data } = await axios.put<ProviderConfig>('/api/providers/config', body);
  return data;
}
