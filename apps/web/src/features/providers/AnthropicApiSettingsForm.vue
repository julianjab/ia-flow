<script setup lang="ts">
// Provider-wide defaults for `anthropic-api`. Actúan como fallback cuando un agente
// no define su propio `providerConfig` (ver AgentEditorModal → sección per-agent).
// Precedencia efectiva: agent.providerConfig > estos defaults.
import { computed } from 'vue';
import type { McpServers } from '@ia-flow/shared';
import type { AnthropicApiSettings } from '@/features/providers/store';
import McpServersEditor from '@/features/providers/McpServersEditor.vue';
import ModelSelect from '@/features/providers/ModelSelect.vue';

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

function updateMcp(value: McpServers) {
  update('mcpServers', value);
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
      <label for="anthropic-task-budget">Task budget (tokens)</label>
      <input
        id="anthropic-task-budget"
        type="number"
        min="20000"
        step="1000"
        placeholder="— sin límite (usa maxTokens por respuesta) —"
        :value="modelValue.taskBudgetTokens ?? ''"
        @input="update('taskBudgetTokens', ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value))"
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

    <div class="field field-block">
      <label>MCP servers</label>
      <McpServersEditor :model-value="modelValue.mcpServers" @update:model-value="updateMcp" />
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
.field-block {
  flex-direction: column;
  align-items: stretch;
  gap: 0.4rem;
}
.field-block > label {
  min-width: 0;
}
</style>
