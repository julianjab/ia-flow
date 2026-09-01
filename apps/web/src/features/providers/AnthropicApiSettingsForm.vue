<script setup lang="ts">
// Provider-wide defaults for `anthropic-api`. Actúan como fallback cuando un agente
// no define su propio `providerConfig` (ver AgentEditorModal → sección per-agent).
// Precedencia efectiva: agent.providerConfig > estos defaults.
import { computed } from 'vue';
import type { McpServers } from '@ia-flow/shared';
import type { AnthropicApiSettings } from '@/features/providers/store';
import ConcurrencyCapField from '@/ui/ConcurrencyCapField.vue';
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
    <div class="ff-row">
      <label class="uc-label">Model</label>
      <ModelSelect :model-value="modelValue.model" @update:model-value="update('model', $event ?? '')" />
    </div>

    <div class="ff-row">
      <label class="uc-label" for="anthropic-response-language">Response language</label>
      <input
        id="anthropic-response-language"
        type="text"
        class="ff-field"
        :value="modelValue.responseLanguage"
        @input="update('responseLanguage', ($event.target as HTMLInputElement).value)"
      />
    </div>

    <div class="ff-row">
      <label class="uc-label" for="anthropic-thinking-type">Thinking type</label>
      <select
        class="ff-field"
        id="anthropic-thinking-type"
        :value="thinkingType"
        @change="updateThinking('type', ($event.target as HTMLSelectElement).value as 'enabled' | 'adaptive')"
      >
        <option value="enabled">enabled</option>
        <option value="adaptive">adaptive</option>
      </select>
    </div>

    <div class="ff-row">
      <label class="uc-label" for="anthropic-thinking-budget">Thinking budget tokens</label>
      <input
        id="anthropic-thinking-budget"
        type="number"
        class="ff-field"
        min="0"
        :value="thinkingBudget"
        @input="updateThinking('budget_tokens', Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <div class="ff-row">
      <ConcurrencyCapField
        :model-value="modelValue.maxConcurrentRuns ?? null"
        label="Máx. runs en paralelo"
        hint="Un agente que declara varios providers candidatos salta al siguiente cuando este está al tope; si ninguno puede, el issue queda en cola."
        @update:model-value="update('maxConcurrentRuns', $event ?? undefined)"
      />
    </div>

    <div class="ff-row">
      <label class="uc-label" for="anthropic-task-budget">Task budget (tokens)</label>
      <input
        id="anthropic-task-budget"
        type="number"
        class="ff-field"
        min="20000"
        step="1000"
        placeholder="— sin límite (usa maxTokens por respuesta) —"
        :value="modelValue.taskBudgetTokens ?? ''"
        @input="update('taskBudgetTokens', ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <div class="ff-row">
      <label class="uc-label" for="anthropic-max-tokens">Max tokens por respuesta</label>
      <input
        id="anthropic-max-tokens"
        type="number"
        class="ff-field"
        min="1024"
        step="1024"
        :value="modelValue.maxTokens ?? 32000"
        @input="update('maxTokens', Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <div class="ff-row">
      <label class="uc-label" for="anthropic-effort">Effort</label>
      <select
        class="ff-field"
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
      <label class="uc-label">MCP servers</label>
      <McpServersEditor :model-value="modelValue.mcpServers" @update:model-value="updateMcp" />
    </div>

    <div class="field field-inline">
      <label class="uc-label" for="anthropic-stream">
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

<style scoped src="@/ui/form-fields.css"></style>
<style scoped>
/* La caja del campo es `.ff-row` del kit. Este form era el único con la
   etiqueta a la IZQUIERDA (`min-width: 12rem`) y por eso los dos controles
   compartidos que se le inyectan —`ConcurrencyCapField`, `McpServersEditor`,
   los dos verticales— quedaban con su label colgando arriba en medio de una
   columna de labels alineadas al costado. */
.anthropic-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
</style>
