<script setup lang="ts">
import { computed } from 'vue';
import type { AnthropicApiSettings } from '../stores/providers';

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
</script>

<template>
  <div class="anthropic-form">
    <div class="field">
      <label for="anthropic-model">Model</label>
      <input
        id="anthropic-model"
        type="text"
        :value="modelValue.model"
        @input="update('model', ($event.target as HTMLInputElement).value)"
      />
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
