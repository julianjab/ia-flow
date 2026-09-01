<script setup lang="ts">
import { computed, ref } from 'vue';
import ModelSelect from '@/features/providers/ModelSelect.vue';

// Per-agent providerConfig shape for the anthropic-api provider. Mirrors
// the strict Zod schema in apps/server/src/providers/anthropic-api.ts;
// keep the fields in sync.
export interface AnthropicApiProviderConfig {
  model?: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  taskBudgetTokens?: number;
  maxPauseTurnRetries?: number;
  retryTruncatedToolUse?: boolean;
  thinkingBudgetTokens?: number;
  eagerMcpTools?: boolean;
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

function checkboxInput(e: Event): boolean | undefined {
  const checked = (e.target as HTMLInputElement).checked;
  // Unchecked → delete the key (falls back to global/default) rather than
  // persisting an explicit `false`, matching every other field's "empty
  // clears the override" behavior.
  return checked ? true : undefined;
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

// Campos beta/de uso poco frecuente — separados de "uso diario" (Model,
// Effort, Max tokens) para que elegir el modelo no pese lo mismo
// visualmente que un flag de reintento de la beta de task-budgets.
const advancedCount = computed(() =>
  [
    state.value.taskBudgetTokens,
    state.value.thinkingBudgetTokens,
    state.value.maxPauseTurnRetries,
    state.value.retryTruncatedToolUse,
    state.value.eagerMcpTools,
  ].filter((v) => v !== undefined && v !== null).length,
);
// Si el agente ya trae algo cargado ahí, no lo escondas detrás de un click.
const advancedOpen = ref(advancedCount.value > 0);
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
    <p v-if="effortWarning" class="pc-warning">⚠ {{ effortWarning }}</p>
  </div>

  <button
    type="button"
    class="pc-disclosure"
    :class="{ 'pc-disclosure--open': advancedOpen }"
    @click="advancedOpen = !advancedOpen"
  >
    <span class="pc-disclosure-arrow">▸</span>
    Opciones avanzadas / beta
    <span v-if="advancedCount" class="pc-disclosure-count">({{ advancedCount }})</span>
  </button>

  <div v-if="advancedOpen" class="pc-grid pc-grid--advanced">
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
    <div class="pc-field">
      <label class="pc-label">Thinking budget (tokens)</label>
      <input
        type="number"
        min="1024"
        class="input"
        placeholder="— adaptive (default) —"
        :value="state.thinkingBudgetTokens ?? ''"
        @input="(e) => set('thinkingBudgetTokens', numberInput(e))"
      />
      <p class="field-hint">Fuerza thinking extendido en modo fijo (en vez de adaptive). Mínimo 1024 y debe quedar por debajo de Max tokens — si no entra, se ignora y usa el default global.</p>
    </div>
    <div class="pc-field">
      <label class="pc-label">Max pause_turn retries</label>
      <input
        type="number"
        min="0"
        max="20"
        class="input"
        placeholder="0"
        :value="state.maxPauseTurnRetries ?? ''"
        @input="(e) => set('maxPauseTurnRetries', numberInput(e))"
      />
      <p class="field-hint">Reintentos cuando la API pausa un turno largo de server tools/MCP (stop_reason pause_turn) — reenvía el historial sin cambios. 0 = sin reintento (default), hasta 20.</p>
    </div>
    <div class="pc-field pc-field--checkbox">
      <label class="pc-check">
        <input
          type="checkbox"
          :checked="state.retryTruncatedToolUse ?? false"
          @change="(e) => set('retryTruncatedToolUse', checkboxInput(e))"
        />
        Reintentar tool_use cortado por max_tokens
      </label>
      <p class="field-hint">Si max_tokens corta un tool_use a mitad del JSON, reintenta una vez esa misma request con más tokens en vez de dar el run por truncado.</p>
    </div>
    <div class="pc-field pc-field--checkbox">
      <label class="pc-check">
        <input
          type="checkbox"
          :checked="state.eagerMcpTools ?? false"
          @change="(e) => set('eagerMcpTools', checkboxInput(e))"
        />
        Cargar todas las tools MCP desde el inicio
      </label>
      <p class="field-hint">Por default las tools de cada servidor MCP van diferidas: el modelo las busca y carga sólo las que necesita, y el catálogo no pesa en cada vuelta. Marcalo para un agente que usa el catálogo entero o cuyo prompt no lo prepara para buscar.</p>
    </div>
  </div>
</template>

<style scoped>
.pc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.85rem; }
.pc-field { display: flex; flex-direction: column; gap: 0.35rem; }
.pc-label { font-size: 0.85rem; font-weight: 500; color: var(--fg-mute); }
.field-hint { margin: 0; font-size: 0.75rem; color: var(--fg-dim); }
.input {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.9rem;
}
.select { background: var(--panel); }
.pc-field--checkbox { justify-content: center; }
.pc-check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; cursor: pointer; }
.pc-check input { width: 1rem; height: 1rem; }
.pc-warning {
  grid-column: 1 / -1;
  margin: 0;
  padding: 0.5rem 0.75rem;
  background: var(--yellow-bg);
  border: 1px solid var(--warn);
  color: var(--warn);
  border-radius: 6px;
  font-size: 0.8rem;
}

.pc-disclosure {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.7rem;
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 500;
  padding: 0.2rem 0;
}
.pc-disclosure-arrow { display: inline-block; transition: transform 0.12s; }
.pc-disclosure--open .pc-disclosure-arrow { transform: rotate(90deg); }
.pc-disclosure-count { color: var(--fg-dim); font-weight: 400; }

.pc-grid--advanced {
  margin-top: 0.6rem;
  padding-top: 0.7rem;
  border-top: 1px dashed var(--border);
}
</style>
