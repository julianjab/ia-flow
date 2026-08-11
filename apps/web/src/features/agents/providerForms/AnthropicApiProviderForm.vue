<script setup lang="ts">
import { computed } from 'vue';
import ModelSelect from '@/features/providers/ModelSelect.vue';

// Per-agent providerConfig shape for the anthropic-api provider. Mirrors
// the strict Zod schema in apps/server/src/providers/anthropic-api.ts;
// keep the fields in sync.
export interface AnthropicApiProviderConfig {
  model?: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  taskBudgetTokens?: number;
}

const props = defineProps<{ modelValue: Record<string, unknown> }>();
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>();

// The parent hands us an opaque blob; project onto the strict shape.
const state = computed<AnthropicApiProviderConfig>(() => props.modelValue as AnthropicApiProviderConfig);

function set<K extends keyof AnthropicApiProviderConfig>(key: K, value: AnthropicApiProviderConfig[K]) {
  const next: Record<string, unknown> = { ...props.modelValue };
  if (value === undefined || value === null || value === '') delete next[key as string];
  else next[key as string] = value;
  emit('update:modelValue', next);
}

function numberInput(e: Event): number | undefined {
  const v = (e.target as HTMLInputElement).value;
  return v === '' ? undefined : Number(v);
}

function isOpusModel(model: string | undefined): boolean {
  if (!model) return false;
  return /opus/i.test(model);
}

const effortWarning = computed(() => {
  const { effort, taskBudgetTokens, model } = state.value;
  const highEffort = effort === 'xhigh' || effort === 'max';
  if ((highEffort || taskBudgetTokens != null) && !isOpusModel(model)) {
    return 'Los valores de effort xhigh/max y task budget se aprovechan mejor con Opus 4.6/4.7.';
  }
  return '';
});
</script>

<template>
  <div class="pc-grid">
    <div class="pc-field">
      <label class="pc-label">Model</label>
      <ModelSelect
        :model-value="state.model"
        :allow-empty="true"
        empty-label="— usa el modelo global —"
        @update:model-value="(v) => set('model', v)"
      />
      <p class="field-hint">Opus, Sonnet, Haiku — sobrescribe el modelo global.</p>
    </div>
    <div class="pc-field">
      <label class="pc-label">Max tokens</label>
      <input
        type="number"
        min="1"
        class="input"
        placeholder="32000"
        :value="state.maxTokens ?? ''"
        @input="(e) => set('maxTokens', numberInput(e))"
      />
      <p class="field-hint">Máximo de tokens generados por respuesta. Default 32000.</p>
    </div>
    <div class="pc-field">
      <label class="pc-label">Effort</label>
      <select
        class="input select"
        :value="state.effort ?? ''"
        @change="(e) => set('effort', (((e.target as HTMLSelectElement).value || undefined) as AnthropicApiProviderConfig['effort']))"
      >
        <option value="">— default —</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
        <option value="xhigh">xhigh</option>
        <option value="max">max</option>
      </select>
      <p class="field-hint">Nivel de esfuerzo/razonamiento. xhigh/max requieren Opus 4.6/4.7.</p>
    </div>
    <div class="pc-field">
      <label class="pc-label">Task budget (tokens)</label>
      <input
        type="number"
        min="20000"
        class="input"
        placeholder="≥ 20000"
        :value="state.taskBudgetTokens ?? ''"
        @input="(e) => set('taskBudgetTokens', numberInput(e))"
      />
      <p class="field-hint">Presupuesto total de tokens por tarea (beta task-budgets). Mínimo 20000. Recomendado Opus 4.6/4.7. Sin valor, hereda del global.</p>
    </div>
    <p v-if="effortWarning" class="pc-warning">⚠ {{ effortWarning }}</p>
  </div>
</template>

<style scoped>
.pc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.85rem; }
.pc-field { display: flex; flex-direction: column; gap: 0.35rem; }
.pc-label { font-size: 0.85rem; font-weight: 500; color: #374151; }
.field-hint { margin: 0; font-size: 0.75rem; color: #6b7280; }
.input {
  padding: 0.5rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.9rem;
}
.select { background: #fff; }
.pc-warning {
  grid-column: 1 / -1;
  margin: 0;
  padding: 0.5rem 0.75rem;
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
  border-radius: 6px;
  font-size: 0.8rem;
}
</style>
