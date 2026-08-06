<script setup lang="ts">
// Provider-wide defaults for `anthropic-api`. Actúan como fallback cuando un agente
// no define su propio `providerConfig` (ver AgentEditorModal → sección per-agent).
// Precedencia efectiva: agent.providerConfig > agent.maxIters (legacy) > estos defaults.
import { computed } from 'vue';
import type { AnthropicApiSettings } from '../stores/providers';
import ModelSelect from './ModelSelect.vue';

const props = defineProps<{
  modelValue: AnthropicApiSettings;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: AnthropicApiSettings): void;
}>();

function update<K extends keyof AnthropicApiSettings>(key: K, value: AnthropicApiSettings[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function updateThinking<K extends keyof NonNullable<AnthropicApiSettings['thinking']>>(
  key: K,
  value: NonNullable<AnthropicApiSettings['thinking']>[K],
) {
  const current = props.modelValue.thinking ?? { type: 'enabled', budget_tokens: 0 };
  emit('update:modelValue', {
    ...props.modelValue,
    thinking: { ...current, [key]: value },
  });
}

const thinkingType = computed(() => props.modelValue.thinking?.type ?? 'enabled');
const thinkingBudget = computed(() => props.modelValue.thinking?.budget_tokens ?? 0);

function updateEffort(val: string) {
  update('effort', (val || undefined) as AnthropicApiSettings['effort']);
}
</script>

<template>
  <div class="anthropic-form">
    <div class="field">
      <label>Model</label>
      <ModelSelect :model-value="modelValue.model" @update:model-value="update('model', $event ?? '')" />
    </div>

    <div class="field">
      <label for="anthropic-response-language">Response language</label>
      <input
        id="anthropic-response-language"
        type="text"
        :value="modelValue.responseLanguage"
        @input="update('responseLanguage', ($event.target as HTMLInputElement).value)"
      />
    </div>

    <div class="field">
      <label for="anthropic-thinking-type">Thinking type</label>
      <select
        id="anthropic-thinking-type"
        :value="thinkingType"
        @change="updateThinking('type', ($event.target as HTMLSelectElement).value as 'enabled' | 'adaptive')"
      >
        <option value="enabled">enabled</option>
        <option value="adaptive">adaptive</option>
      </select>
    </div>

    <div class="field">
      <label for="anthropic-thinking-budget">Thinking budget tokens</label>
      <input
        id="anthropic-thinking-budget"
        type="number"
        min="0"
        :value="thinkingBudget"
        @input="updateThinking('budget_tokens', Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <div class="field">
      <label for="anthropic-max-iters">Max iteraciones de herramientas</label>
      <input
        id="anthropic-max-iters"
        type="number"
        min="1"
        max="100"
        :value="modelValue.maxIters ?? 15"
        @input="update('maxIters', Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <div class="field">
      <label for="anthropic-max-tokens">Max tokens por respuesta</label>
      <input
        id="anthropic-max-tokens"
        type="number"
        min="1024"
        step="1024"
        :value="modelValue.maxTokens ?? 32000"
        @input="update('maxTokens', Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <div class="field">
      <label for="anthropic-effort">Effort</label>
      <select
        id="anthropic-effort"
        :value="modelValue.effort ?? ''"
        @change="updateEffort(($event.target as HTMLSelectElement).value)"
      >
        <option value="">— default (omit) —</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
        <option value="xhigh">xhigh (Opus 4.7)</option>
        <option value="max">max (Opus only)</option>
      </select>
    </div>

    <div class="field field-inline">
      <label for="anthropic-stream">
        <input
          id="anthropic-stream"
          type="checkbox"
          :checked="modelValue.stream"
          @change="update('stream', ($event.target as HTMLInputElement).checked)"
        />
        Stream
      </label>
    </div>
  </div>
</template>

<style scoped>
.anthropic-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.field {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.field label {
  min-width: 12rem;
  font-weight: 500;
}
.field input[type='text'],
.field input[type='number'],
.field select {
  flex: 1;
  padding: 0.35rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
}
.field-inline label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
</style>
