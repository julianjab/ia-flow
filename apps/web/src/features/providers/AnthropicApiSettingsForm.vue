<script setup lang="ts">
// Provider-wide defaults for `anthropic-api`. Actúan como fallback cuando un agente
// no define su propio `providerConfig` (ver AgentEditorModal → sección per-agent).
// Precedencia efectiva: agent.providerConfig > estos defaults.
//
// Ocho campos planos, todos con el mismo peso, se vuelven tres visibles y tres
// bloques plegados: lo que se toca es el modelo, el effort y el stream; los
// cinco numéricos tienen default y pasan el test de las tres condiciones para
// plegarse (R20), con su valor efectivo en el encabezado (R22).
import { computed } from 'vue';
import { type McpServers, validateAnthropicApiSettings } from '@ia-flow/shared';
import type { AnthropicApiSettings } from '@/features/providers/store';
import CollapsibleSection from '@/ui/CollapsibleSection.vue';
import ConcurrencyCapField from '@/ui/ConcurrencyCapField.vue';
import ToggleSwitch from '@/ui/ToggleSwitch.vue';
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

// ─── Errores, en el campo que los causa ───────────────────────────────────
//
// `validateAnthropicApiSettings` objeta una COMBINACIÓN (effort beta o task
// budget contra un modelo que no es Opus), y el cartel único bajo la sección
// dejaba al usuario buscando cuál de los ocho campos la había roto. El mensaje
// va donde está el control que lo despeja — y en el lugar del hint, nunca
// apilado con él (R18).
const effortError = computed(() =>
  validateAnthropicApiSettings({
    model: props.modelValue.model,
    effort: props.modelValue.effort,
  }),
);
const taskBudgetError = computed(() =>
  validateAnthropicApiSettings({
    model: props.modelValue.model,
    taskBudgetTokens: props.modelValue.taskBudgetTokens,
  }),
);

// ─── Resúmenes de las secciones plegadas — el VALOR, no la descripción ────

const limitsSummary = computed(() => {
  const parts = [`${Math.round((props.modelValue.maxTokens ?? 32000) / 1000)}k por respuesta`];
  const cap = props.modelValue.maxConcurrentRuns;
  parts.push(cap ? `${cap} en paralelo` : 'sin tope de runs');
  if (props.modelValue.taskBudgetTokens) {
    parts.push(`${Math.round(props.modelValue.taskBudgetTokens / 1000)}k por tarea`);
  }
  return parts.join(' · ');
});

const thinkingSummary = computed(() =>
  thinkingBudget.value ? `${thinkingType.value} · ${thinkingBudget.value}` : thinkingType.value,
);

const mcpSummary = computed(() => {
  const n = Object.keys(props.modelValue.mcpServers ?? {}).length;
  return n ? `${n} servidor${n === 1 ? '' : 'es'}` : 'ninguno';
});
</script>

<template>
  <div class="anthropic-form">
    <!-- Lo que se toca, visible: modelo, effort y stream. -->
    <div class="ff-row">
      <label class="uc-label">Model</label>
      <ModelSelect :model-value="modelValue.model" @update:model-value="update('model', $event ?? '')" />
    </div>

    <div class="ff-row">
      <label class="uc-label" for="anthropic-effort">Effort</label>
      <select
        class="ff-field"
        :class="{ 'ff-field--error': effortError }"
        id="anthropic-effort"
        :value="modelValue.effort ?? ''"
        @change="updateEffort(($event.target as HTMLSelectElement).value)"
      >
        <option value="">— default (omit) —</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
        <option value="xhigh">xhigh (requiere Opus)</option>
        <option value="max">max (requiere Opus)</option>
      </select>
      <p v-if="effortError" class="ff-error">{{ effortError }}</p>
    </div>

    <div class="ff-row">
      <ToggleSwitch
        :model-value="modelValue.stream ?? false"
        label="Stream"
        @update:model-value="update('stream', $event)"
      />
    </div>

    <!-- Lo que tiene default y se puede ignorar, plegado. -->
    <CollapsibleSection title="Límites" :summary="limitsSummary">
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

      <ConcurrencyCapField
        :model-value="modelValue.maxConcurrentRuns ?? null"
        label="Máx. runs en paralelo"
        hint="Al tope, un agente con varios providers candidatos salta al siguiente; si ninguno puede, el issue queda en cola."
        @update:model-value="update('maxConcurrentRuns', $event ?? undefined)"
      />

      <div class="ff-row">
        <label class="uc-label" for="anthropic-task-budget">Task budget (tokens)</label>
        <input
          id="anthropic-task-budget"
          type="number"
          class="ff-field"
          :class="{ 'ff-field--error': taskBudgetError }"
          min="20000"
          step="1000"
          placeholder="— sin límite —"
          :value="modelValue.taskBudgetTokens ?? ''"
          @input="update('taskBudgetTokens', ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value))"
        />
        <p v-if="taskBudgetError" class="ff-error">{{ taskBudgetError }}</p>
        <p v-else class="ff-hint">Presupuesto de toda la corrida, no de una respuesta.</p>
      </div>
    </CollapsibleSection>

    <CollapsibleSection title="Thinking" :summary="thinkingSummary">
      <div class="ff-row">
        <label class="uc-label" for="anthropic-thinking-type">Tipo</label>
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
        <label class="uc-label" for="anthropic-thinking-budget">Budget tokens</label>
        <input
          id="anthropic-thinking-budget"
          type="number"
          class="ff-field"
          min="0"
          :value="thinkingBudget"
          @input="updateThinking('budget_tokens', Number(($event.target as HTMLInputElement).value))"
        />
      </div>
    </CollapsibleSection>

    <CollapsibleSection title="MCP servers" :summary="mcpSummary">
      <McpServersEditor :model-value="modelValue.mcpServers" @update:model-value="updateMcp" />
    </CollapsibleSection>
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
