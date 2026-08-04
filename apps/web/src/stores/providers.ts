import { defineStore } from 'pinia';
import { ref } from 'vue';

export type StepId = 'refine-functional' | 'refine-technical' | 'implement';
export type ProviderId = 'anthropic-api' | 'tmux-claude' | 'iterm-claude';

export interface Provider {
  id: ProviderId;
  name?: string;
}

export interface AnthropicApiSettings {
  model: string;
  responseLanguage: string;
  thinking?: { type: 'enabled' | 'adaptive'; budget_tokens: number };
  stream: boolean;
  // Out of scope for this PR — preserved on save.
  systemPrompt?: Array<{ type: 'text'; text: string }>;
  anthropicVersion?: string;
  anthropicBeta?: string[];
}

export interface ProviderConfig {
  steps: Record<StepId, ProviderId>;
  anthropicApi: AnthropicApiSettings;
}

export interface ProviderConfigPatch {
  steps?: Partial<Record<StepId, ProviderId>>;
  anthropicApi?: Partial<AnthropicApiSettings>;
}

const REGISTERED_PROVIDERS: Provider[] = [
  { id: 'anthropic-api', name: 'Claude API (headless)' },
  { id: 'tmux-claude', name: 'Claude Code (tmux)' },
  { id: 'iterm-claude', name: 'Claude Code (iTerm)' },
];

// TODO(open_questions): base URL should be configurable via env.
const API_BASE = '/api';

export const useProvidersStore = defineStore('providers', () => {
  const providers = ref<Provider[]>(REGISTERED_PROVIDERS);
  const config = ref<ProviderConfig | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchConfig(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch(`${API_BASE}/providers`);
      if (!res.ok) throw new Error(`GET /providers ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data.providers)) providers.value = data.providers;
      config.value = data.config ?? data;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function saveConfig(patch: ProviderConfigPatch): Promise<ProviderConfig> {
    const current = config.value;
    const body: ProviderConfig = {
      steps: { ...(current?.steps ?? {} as Record<StepId, ProviderId>), ...patch.steps },
      anthropicApi: {
        ...(current?.anthropicApi ?? {} as AnthropicApiSettings),
        ...patch.anthropicApi,
      },
    };
    const res = await fetch(`${API_BASE}/providers/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PUT /providers/config ${res.status}`);
    const saved = (await res.json()) as ProviderConfig;
    config.value = saved;
    return saved;
  }

  return { providers, config, loading, error, fetchConfig, saveConfig };
});
