<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import StepProviderSelector from '../components/StepProviderSelector.vue';
import AnthropicApiSettingsForm from '../components/AnthropicApiSettingsForm.vue';
import SystemPromptEditor from '@/components/SystemPromptEditor.vue';
import VariableChipsPanel from '@/components/VariableChipsPanel.vue';
import Toast from '../components/ui/Toast.vue';
import {
  useProvidersStore,
  type AnthropicApiSettings,
  type ProviderId,
  type StepId,
} from '../stores/providers';
import { useToastStore } from '../stores/toast';

const providersStore = useProvidersStore();
const toastStore = useToastStore();

const STEPS: StepId[] = ['refine-functional', 'refine-technical', 'implement'];

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

const saving = ref(false);

const systemPrompt = computed({
  get: () => anthropicApi.value.systemPrompt ?? [],
  set: (value) => {
    anthropicApi.value = { ...anthropicApi.value, systemPrompt: value };
  },
});

function hydrateFromStore() {
  const cfg = providersStore.config;
  if (!cfg) return;
  steps.value = { ...steps.value, ...cfg.steps };
  anthropicApi.value = {
    model: cfg.anthropicApi.model ?? '',
    responseLanguage: cfg.anthropicApi.responseLanguage ?? '',
    thinking: cfg.anthropicApi.thinking ?? { type: 'enabled', budget_tokens: 0 },
    stream: cfg.anthropicApi.stream ?? false,
    systemPrompt: cfg.anthropicApi.systemPrompt ?? [],
    anthropicVersion: cfg.anthropicApi.anthropicVersion ?? '',
    anthropicBeta: cfg.anthropicApi.anthropicBeta ?? [],
  };
}

onMounted(async () => {
  try {
    await providersStore.fetchConfig();
    hydrateFromStore();
  } catch (e) {
    toastStore.error(`Failed to load config: ${e instanceof Error ? e.message : String(e)}`);
  }
});

watch(() => providersStore.config, hydrateFromStore);

const providers = computed(() => providersStore.providers);

async function onSave() {
  saving.value = true;
  try {
    await providersStore.saveConfig({
      steps: { ...steps.value },
      anthropicApi: {
        ...(providersStore.config?.anthropicApi ?? {}),
        ...anthropicApi.value,
      },
    });
    toastStore.success('Configuration saved');
  } catch (e) {
    toastStore.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="settings-view">
    <header class="settings-header">
      <h1>Providers Settings</h1>
    </header>

    <section class="settings-section" data-slot="step-providers">
      <h2>Pipeline steps</h2>
      <StepProviderSelector
        v-for="step in STEPS"
        :key="step"
        :step="step"
        :providers="providers"
        v-model="steps[step]"
      />
    </section>

    <section class="settings-section" data-slot="anthropic-form">
      <h2>Anthropic API</h2>
      <AnthropicApiSettingsForm v-model="anthropicApi" />
    </section>

    <section class="settings-section" data-slot="system-prompt-editor">
      <h2 class="section-title">System Prompt</h2>
      <div class="system-prompt-layout">
        <SystemPromptEditor v-model="systemPrompt" />
        <VariableChipsPanel />
      </div>
    </section>

    <footer class="settings-actions">
      <button
        type="button"
        class="save-button"
        :disabled="saving"
        data-testid="settings-save-button"
        @click="onSave"
      >
        {{ saving ? 'Guardando…' : 'Guardar' }}
      </button>
    </footer>

    <Toast />
  </section>
</template>

<style scoped>
.settings-view {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
.settings-header h1 {
  margin: 0;
  font-size: 1.75rem;
}
.settings-section {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem;
  min-height: 3rem;
}
.settings-section h2,
.section-title {
  margin: 0 0 0.75rem;
  font-size: 1.1rem;
}
.system-prompt-layout {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}
.settings-actions {
  display: flex;
  justify-content: flex-end;
}
.save-button {
  padding: 0.5rem 1.2rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
}
.save-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
