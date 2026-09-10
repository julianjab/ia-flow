<script setup lang="ts">
// Los defaults globales de los tres providers.
//
// Estaban los TRES apilados en una página con un único `Guardar providers` al
// final del documento: la acción principal scrolleaba (R3) y prometía guardar
// más de lo que uno venía a cambiar. Ahora se elige uno con los chips de
// arriba y el pie guarda esa pantalla — que igual manda los tres, porque el
// endpoint es uno y el estado de los otros dos no se tocó.
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, ref, watch } from 'vue';
import { type TerminalProviderSettings, validateAnthropicApiSettings } from '@ia-flow/shared';
import AnthropicApiSettingsForm from '@/features/providers/AnthropicApiSettingsForm.vue';
import ProviderRegistrationsSection from '@/features/providers/ProviderRegistrationsSection.vue';
import TerminalProviderSettingsForm from '@/features/providers/TerminalProviderSettingsForm.vue';
import FormFooter from '@/ui/FormFooter.vue';
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
  thinking: { type: 'enabled', budget_tokens: 0 },
  stream: false,
  systemPrompt: [],
  anthropicVersion: '',
  anthropicBeta: [],
});

const tmuxClaude = ref<TerminalProviderSettings>({});
const itermClaude = ref<TerminalProviderSettings>({});
const providersSaving = ref(false);

const anthropicApiError = computed(() =>
  validateAnthropicApiSettings({
    model: anthropicApi.value.model,
    effort: anthropicApi.value.effort,
    taskBudgetTokens: anthropicApi.value.taskBudgetTokens,
  }),
);

// Un provider por vez. Los tres apilados hacían que el pie prometiera más de
// lo que uno vino a cambiar; el chip dice cuál se está editando.
const PROVIDER_TABS = [
  {
    id: 'anthropic-api' as const,
    desc: 'Se aplican a todo agente que lo use; el providerConfig del agente les gana.',
  },
  {
    id: 'tmux-claude' as const,
    desc: 'Los flags se inyectan en cada sesión de Claude CLI lanzada vía tmux.',
  },
  {
    id: 'iterm-claude' as const,
    desc: 'Los flags y el entorno se aplican en cada tab de iTerm2 antes de ejecutar Claude.',
  },
];
type ProviderTab = (typeof PROVIDER_TABS)[number]['id'];
const activeTab = ref<ProviderTab>('anthropic-api');
const activeDesc = computed(
  () => PROVIDER_TABS.find((t) => t.id === activeTab.value)?.desc ?? '',
);

// Qué hay sin guardar. Sin esto el pie sólo puede ofrecer un `Guardar` que no
// dice si hay algo que guardar — y el usuario no tiene forma de saber si su
// último cambio ya se fue o no.
const savedSnapshot = ref('');
const currentSnapshot = computed(() =>
  JSON.stringify({
    steps: steps.value,
    anthropicApi: anthropicApi.value,
    tmuxClaude: tmuxClaude.value,
    itermClaude: itermClaude.value,
  }),
);
const dirty = computed(() => currentSnapshot.value !== savedSnapshot.value);

const footerNote = computed(() => {
  if (anthropicApiError.value) return anthropicApiError.value;
  return dirty.value ? 'cambios sin guardar' : 'sin cambios';
});

function hydrateFromStore() {
  const cfg = providersStore.config;
  if (!cfg) return;
  const resolvedSteps = Object.fromEntries(
    Object.entries(cfg.steps).map(([step, val]) => [step, typeof val === 'string' ? val : val.provider]),
  ) as Record<StepId, ProviderId>;
  steps.value = { ...steps.value, ...resolvedSteps };
  anthropicApi.value = {
    model: cfg.anthropicApi.model ?? '',
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
  savedSnapshot.value = currentSnapshot.value;
}

hydrateFromStore();
watch(() => providersStore.config, hydrateFromStore);

async function onSaveProviders() {
  // El error ya se ve en el campo que lo causa y el pie lo repite; el toast
  // sólo agregaría una tercera copia del mismo texto.
  if (anthropicApiError.value) return;
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
    savedSnapshot.value = currentSnapshot.value;
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
    <h2>Providers</h2>
    <!-- Una descripción de sección por pantalla, y es de la pantalla — no de
         cada bloque del formulario (R22). Cambia con el provider elegido
         porque es lo único que la fila de chips no alcanza a decir. -->
    <p class="section-desc">{{ activeDesc }}</p>

    <div class="ff-chips provider-tabs">
      <button
        v-for="tab in PROVIDER_TABS"
        :key="tab.id"
        type="button"
        class="ff-chip ff-chip-mono"
        :class="{ 'ff-chip--on': activeTab === tab.id }"
        :aria-pressed="activeTab === tab.id"
        @click="activeTab = tab.id"
      >{{ tab.id }}</button>
    </div>

    <div class="ff-col">
      <AnthropicApiSettingsForm v-if="activeTab === 'anthropic-api'" v-model="anthropicApi" />
      <TerminalProviderSettingsForm
        v-else-if="activeTab === 'tmux-claude'"
        v-model="tmuxClaude"
        show-surface-in-terminal
      />
      <TerminalProviderSettingsForm v-else v-model="itermClaude" />
    </div>

    <FormFooter
      :note="footerNote"
      :note-is-error="!!anthropicApiError"
      :save-disabled="providersSaving || !!anthropicApiError || !dirty"
      :save-label="providersSaving ? 'Guardando…' : 'Guardar'"
      @save="onSaveProviders"
      @cancel="hydrateFromStore"
    />
  </section>

  <ProviderRegistrationsSection />
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
/* Los chips eligen qué provider se edita, así que van pegados a la descripción
   que cambia con ellos y separados del formulario que gobiernan. */
.provider-tabs { margin-bottom: 0.9rem; }
</style>
