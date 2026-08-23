<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { ref, watch } from 'vue';
import type { ProviderLimit, TerminalProviderSettings } from '@ia-flow/shared';
import AnthropicApiSettingsForm from '@/features/providers/AnthropicApiSettingsForm.vue';
import ProviderRegistrationsSection from '@/features/providers/ProviderRegistrationsSection.vue';
import TerminalProviderSettingsForm from '@/features/providers/TerminalProviderSettingsForm.vue';
import ConcurrencyCapField from '@/ui/ConcurrencyCapField.vue';
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
// Cap por provider, indexado por id. Cubre TODOS los providers registrados —
// los locales y los remotos (`remote:<id>`, una instancia de
// ai-provider-gateway) — porque la lista sale del registry del server, no de
// una enumeración fija acá.
const providerLimits = ref<Record<string, number | null>>({});
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
    mcpServers: cfg.anthropicApi.mcpServers,
  };
  tmuxClaude.value = { ...(cfg.tmuxClaude ?? {}) };
  itermClaude.value = { ...(cfg.itermClaude ?? {}) };
  providerLimits.value = Object.fromEntries(
    Object.entries(cfg.providerLimits ?? {}).map(([id, limit]) => [
      id,
      limit?.maxConcurrentRuns && limit.maxConcurrentRuns > 0 ? limit.maxConcurrentRuns : null,
    ]),
  );
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
    } as typeof anthropicApi.value;
    await providersStore.saveConfig({
      steps: { ...steps.value },
      anthropicApi: anthropicApiPayload,
      tmuxClaude: tmuxClaude.value,
      itermClaude: itermClaude.value,
      // Mapa completo, sin las entradas vacías: el server reemplaza el objeto
      // entero, así que un provider que sale de acá queda sin cap.
      providerLimits: Object.fromEntries(
        Object.entries(providerLimits.value)
          .filter(([, v]) => !!v)
          .map(([id, v]) => [id, { maxConcurrentRuns: v as number }]),
      ) as Record<string, ProviderLimit>,
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

  <section class="settings-section">
    <h2>Límites de concurrencia</h2>
    <p class="section-desc">
      Cuántos runs simultáneos acepta cada provider. Cuando un agente declara varios providers
      candidatos, el engine <strong>salta al siguiente</strong> si el primero está al tope; sólo
      si todos lo están el issue queda en cola y se reintenta al liberarse un slot. Vacío = sin
      límite.
    </p>
    <div class="limits-grid">
      <ConcurrencyCapField
        v-for="p in providersStore.providers"
        :key="p.id"
        :model-value="providerLimits[p.id] ?? null"
        :label="p.name"
        @update:model-value="providerLimits[p.id] = $event"
      />
    </div>
    <p class="section-desc section-desc--foot">
      Este cap cuenta sólo lo que despacha <em>este</em> daemon. Un gateway remoto compartido
      lleva además el suyo (<code>GATEWAY_MAX_CONCURRENT_RUNS</code>) y el engine lo consulta
      antes de mandarle trabajo.
    </p>
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
.limits-grid { display: flex; flex-wrap: wrap; gap: 1rem 1.5rem; }
.section-desc--foot { margin: 0.9rem 0 0; }
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
