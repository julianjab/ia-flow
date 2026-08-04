<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import SystemPromptEditor from '@/components/SystemPromptEditor.vue';
import VariableChipsPanel from '@/components/VariableChipsPanel.vue';
import { useProvidersStore } from '@/stores/providers';

const store = useProvidersStore();
const savedMessage = ref<string | null>(null);

const systemPrompt = computed({
  get: () => store.config.anthropicApi.systemPrompt,
  set: (value) => {
    store.config.anthropicApi.systemPrompt = value;
  },
});

onMounted(() => {
  void store.fetchConfig();
});

async function onSave(): Promise<void> {
  savedMessage.value = null;
  const ok = await store.saveConfig();
  savedMessage.value = ok ? 'Configuración guardada' : 'Error al guardar';
}
</script>

<template>
  <section class="settings-view">
    <header class="settings-header">
      <h1>Providers Settings</h1>
    </header>

    <section class="settings-section" data-slot="step-providers">
      <!-- TODO: step provider selectors -->
    </section>

    <section class="settings-section" data-slot="anthropic-form">
      <!-- TODO: Anthropic API settings form -->
    </section>

    <section class="settings-section" data-slot="system-prompt-editor">
      <h2 class="section-title">System Prompt</h2>
      <div class="system-prompt-layout">
        <SystemPromptEditor v-model="systemPrompt" />
        <VariableChipsPanel />
      </div>
    </section>

    <footer class="settings-footer">
      <button
        type="button"
        class="save-button"
        :disabled="store.saving"
        data-testid="settings-save-button"
        @click="onSave"
      >
        {{ store.saving ? 'Guardando…' : 'Guardar' }}
      </button>
      <span v-if="savedMessage" class="save-message">{{ savedMessage }}</span>
    </footer>
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
.section-title {
  margin: 0 0 0.75rem 0;
  font-size: 1rem;
  color: #111827;
}
.system-prompt-layout {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}
.settings-footer {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.save-button {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  border: 1px solid #4f46e5;
  background: #4f46e5;
  color: white;
  cursor: pointer;
  font-size: 0.875rem;
}
.save-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.save-message {
  font-size: 0.875rem;
  color: #059669;
}
</style>
