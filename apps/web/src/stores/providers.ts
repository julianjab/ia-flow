import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { SystemPromptBlock } from '@/components/SystemPromptEditor.vue';

// TODO: full providers store is delivered in a separate sub-issue (see #3364).
// This minimal shape only exposes what the system prompt editor needs so that
// this PR can be integrated end-to-end. It will be superseded when the full
// providers store PR lands and can be merged into that store.

export interface AnthropicApiConfig {
  systemPrompt: SystemPromptBlock[];
}

export interface ProviderConfig {
  anthropicApi: AnthropicApiConfig;
}

const EMPTY_CONFIG: ProviderConfig = {
  anthropicApi: { systemPrompt: [] },
};

export const useProvidersStore = defineStore('providers', () => {
  const config = ref<ProviderConfig>(structuredClone(EMPTY_CONFIG));
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);

  async function fetchConfig(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch('/api/providers/config');
      if (!res.ok) throw new Error(`GET /api/providers/config ${res.status}`);
      const data = (await res.json()) as Partial<ProviderConfig>;
      config.value = {
        anthropicApi: {
          systemPrompt: data.anthropicApi?.systemPrompt ?? [],
        },
      };
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function saveConfig(): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      const res = await fetch('/api/providers/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config.value),
      });
      if (!res.ok) throw new Error(`PUT /api/providers/config ${res.status}`);
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      saving.value = false;
    }
  }

  return { config, loading, saving, error, fetchConfig, saveConfig };
});
