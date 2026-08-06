import { defineStore } from 'pinia';
import { getEnvVars, updateEnvVars, type EnvVarState } from '@/api/env-vars';

interface State {
  vars: Record<string, EnvVarState>;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

export const useEnvVarsStore = defineStore('env-vars', {
  state: (): State => ({
    vars: {},
    loading: false,
    saving: false,
    error: null,
  }),
  actions: {
    async fetch() {
      this.loading = true;
      this.error = null;
      try {
        this.vars = await getEnvVars();
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Error loading env vars';
      } finally {
        this.loading = false;
      }
    },
    async save(patch: Record<string, string>) {
      this.saving = true;
      this.error = null;
      try {
        await updateEnvVars(patch);
        await this.fetch();
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Error saving env vars';
        throw err;
      } finally {
        this.saving = false;
      }
    },
  },
});
