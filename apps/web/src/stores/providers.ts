import { defineStore } from 'pinia';
import axios from 'axios';
import type { ProviderConfig, StepType } from '@ia-flow/shared';
import {
  getProviders,
  updateProviderConfig,
  type ProviderInfo,
  type UpdateProviderConfigBody,
} from '@/api/providers';

interface State {
  providers: ProviderInfo[];
  config: ProviderConfig | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

const STEPS_LIST: StepType[] = ['refine-functional', 'refine-technical', 'implement'];

function extractError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string; message?: string } | undefined;
    return data?.error ?? data?.message ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

export const useProvidersStore = defineStore('providers', {
  state: (): State => ({
    providers: [],
    config: null,
    loading: false,
    saving: false,
    error: null,
  }),
  getters: {
    stepsList: (): StepType[] => STEPS_LIST,
  },
  actions: {
    async fetchConfig() {
      this.loading = true;
      this.error = null;
      try {
        const { providers, config } = await getProviders();
        this.providers = providers;
        this.config = config;
      } catch (err) {
        this.error = extractError(err);
      } finally {
        this.loading = false;
      }
    },
    async saveConfig(patch: UpdateProviderConfigBody) {
      this.saving = true;
      this.error = null;
      try {
        const config = await updateProviderConfig(patch);
        this.config = config;
      } catch (err) {
        this.error = extractError(err);
      } finally {
        this.saving = false;
      }
    },
  },
});
