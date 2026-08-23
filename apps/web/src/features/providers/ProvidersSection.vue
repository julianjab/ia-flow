<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { ref, watch } from 'vue';
import type { TerminalProviderSettings } from '@ia-flow/shared';
import AnthropicApiSettingsForm from '@/features/providers/AnthropicApiSettingsForm.vue';
import ProviderRegistrationsSection from '@/features/providers/ProviderRegistrationsSection.vue';
import TerminalProviderSettingsForm from '@/features/providers/TerminalProviderSettingsForm.vue';
import {
  useProvidersStore,
  type AnthropicApiSettings,
  type ProviderId,
  type StepId,
} from '@/features/providers/store';
import { useToastStore } from '@/stores/toast';

const providersStore = useProvidersStore();
const toastStore = useToastStore();

const steps = ref<Record<StepId, ProviderId>>({
  'refine-functional': 'anthropic-api',
  'refine-technical': 'anthropic-api',
  implement: 'anthropic-api',
});

const anthropicApi = ref<AnthropicApiSettings>({
  model: '',
  responseLanguage: '',
  thinking: { type: 'enabled', budget_tokens: 0 },
  stream: false,
  systemPrompt: [],
  anthropicVersion: '',
  anthropicBeta: [],
});

const tmuxClaude = ref<TerminalProviderSettings>({});
const itermClaude = ref<TerminalProviderSettings>({});
const providersSaving = ref(false);

function hydrateFromStore() {
  const cfg = providersStore.config;
  if (!cfg) return;
  const resolvedSteps = Object.fromEntries(
    Object.entries(cfg.steps).map(([step, val]) => [step, typeof val === 'string' ? val : val.provider]),
  ) as Record<StepId, ProviderId>;
  steps.value = { ...steps.value, ...resolvedSteps };
  anthropicApi.value = {
    model: cfg.anthropicApi.model ?? '',
    responseLanguage: cfg.anthropicApi.responseLanguage ?? '',
    thinking: cfg.anthropicApi.thinking ?? { type: 'enabled', budget_tokens: 0 },
    stream: cfg.anthropicApi.stream ?? false,
    systemPrompt: cfg.anthropicApi.systemPrompt ?? [],
    anthropicVersion: cfg.anthropicApi.anthropicVersion ?? '',
    anthropicBeta: cfg.anthropicApi.anthropicBeta ?? [],
    maxTokens: cfg.anthropicApi.maxTokens,
    effort: cfg.anthropicApi.effort,
    taskBudgetTokens: cfg.anthropicApi.taskBudgetTokens,
    maxConcurrentRuns: cfg.anthropicApi.maxConcurrentRuns,
    mcpServers: cfg.anthropicApi.mcpServers,
  };
  tmuxClaude.value = { ...(cfg.tmuxClaude ?? {}) };
  itermClaude.value = { ...(cfg.itermClaude ?? {}) };
}

hydrateFromStore();
watch(() => providersStore.config, hydrateFromStore);

async function onSaveProviders() {
  providersSaving.value = true;
  try {
    // Send the form state as-is instead of spreading the current config on top
    // of it — with the spread, any field the user cleared came back with its
    // previous value. Optional fields the UI supports clearing (empty input =
    // "use the default") are converted to `null` so the server's merge routine
    // deletes them from the persisted config; `undefined` is omitted by
    // JSON.stringify and would be treated as "keep current".
    const anthropicApiPayload = {
      ...anthropicApi.value,
      taskBudgetTokens: anthropicApi.value.taskBudgetTokens ?? null,
      effort: anthropicApi.value.effort ?? null,
      maxConcurrentRuns: anthropicApi.value.maxConcurrentRuns ?? null,
    } as typeof anthropicApi.value;
    // Mismo motivo que arriba: vaciar el cap tiene que BORRAR la key, y sólo
    // un `null` explícito lo logra — `undefined` lo come JSON.stringify y el
    // merge del server deja el valor viejo.
    const withClearableCap = <T extends TerminalProviderSettings>(settings: T) => ({
      ...settings,
      maxConcurrentRuns: settings.maxConcurrentRuns ?? null,
    });
    await providersStore.saveConfig({
      steps: { ...steps.value },
      anthropicApi: anthropicApiPayload,
      tmuxClaude: withClearableCap(tmuxClaude.value),
      itermClaude: withClearableCap(itermClaude.value),
    });
    toastStore.success('Providers guardados');
  } catch (e) {
    toastStore.error(`Save failed: ${extractErrorMessage(e)}`);
  } finally {
    providersSaving.value = false;
  }
}
</script>

<template>
  <section class="settings-section">
    <h2>anthropic-api</h2>
    <p class="section-desc">
      Defaults globales para el provider <strong>anthropic-api</strong>. Se aplican a todos los
      agentes que lo usen y pueden ser sobreescritos por <code>providerConfig</code> en cada agente.
    </p>
    <AnthropicApiSettingsForm v-model="anthropicApi" />
  </section>

  <section class="settings-section">
    <h2>tmux-claude</h2>
    <p class="section-desc">
      Defaults globales para el provider <strong>tmux-claude</strong>. Los flags se inyectan
      automáticamente en cada sesión de Claude CLI lanzada via tmux.
    </p>
    <TerminalProviderSettingsForm v-model="tmuxClaude" />
  </section>

  <section class="settings-section">
    <h2>iterm-claude</h2>
    <p class="section-desc">
      Defaults globales para el provider <strong>iterm-claude</strong>. Los flags y variables de
      entorno se aplican en cada tab de iTerm2 antes de ejecutar Claude.
    </p>
    <TerminalProviderSettingsForm v-model="itermClaude" />
  </section>

  <footer class="settings-actions">
    <button
      type="button"
      class="save-button"
      :disabled="providersSaving"
      @click="onSaveProviders"
    >
      {{ providersSaving ? 'Guardando…' : 'Guardar providers' }}
    </button>
  </footer>

  <ProviderRegistrationsSection />
</template>

<style scoped>
.settings-section { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: var(--fg-dim); line-height: 1.5; }
.settings-actions { display: flex; justify-content: flex-end; }
.section-desc code { font-family: var(--font-mono); background: var(--panel-hi); padding: 0 0.25rem; }
.save-button {
  padding: 0.5rem 1.4rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  font-size: 0.95rem;
}
.save-button:hover { background: var(--accent); }
.save-button:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
