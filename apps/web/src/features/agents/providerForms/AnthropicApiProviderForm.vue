<script setup lang="ts">
import { computed, ref } from 'vue';
import ModelSelect from '@/features/providers/ModelSelect.vue';
import { validateAnthropicApiSettings } from '@ia-flow/shared';
import { useProvidersStore } from '@/features/providers/store';

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
  maxRetries?: number;
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

const providersStore = useProvidersStore();

// Efectivo, no sólo lo que el agente overridea: sin `model` acá, el agente
// hereda el default global — y es CONTRA ESE modelo que la API valida
// effort/taskBudgetTokens. Mismo cálculo que hace el server al guardar
// (ver anthropicSettingsError en apps/server/src/routes/agents-crud.ts).
const effectiveModel = computed(() => state.value.model ?? providersStore.config?.anthropicApi.model);

// Antes era un warning ("se aprovechan mejor con Opus") que describía como
// preferencia blanda lo que en realidad es un 400 duro de la API — ver PRD
// del issue #143. Ahora es el mismo motivo que el server usaría para
// rechazar el guardado.
const effortError = computed(() =>
  validateAnthropicApiSettings({
    model: effectiveModel.value,
    effort: state.value.effort,
    taskBudgetTokens: state.value.taskBudgetTokens,
  }) ?? '',
);

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
    state.value.maxRetries,
  ].filter((v) => v !== undefined && v !== null).length,
);
// Si el agente ya trae algo cargado ahí, no lo escondas detrás de un click.
const advancedOpen = ref(advancedCount.value > 0);
</script>

<template>
  <div class="pc-grid">
    <div class="ff-row">
      <label class="uc-label">Model</label>
      <ModelSelect
        :model-value="state.model"
        :allow-empty="true"
        empty-label="— usa el modelo global —"
        @update:model-value="(v) => set('model', v)"
      />
      <p class="ff-hint">Opus, Sonnet, Haiku — sobrescribe el modelo global.</p>
    </div>
    <div class="ff-row">
      <label class="uc-label">Max tokens</label>
      <input
        type="number"
        min="1"
        class="ff-field"
        placeholder="32000"
        :value="state.maxTokens ?? ''"
        @input="(e) => set('maxTokens', numberInput(e))"
      />
      <p class="ff-hint">Máximo de tokens generados por respuesta. Default 32000.</p>
    </div>
    <div class="ff-row">
      <label class="uc-label">Effort</label>
      <select
        class="ff-field"
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
      <p class="ff-hint">Nivel de esfuerzo/razonamiento. xhigh/max requieren un modelo Opus (xhigh no existe en Sonnet/Haiku).</p>
    </div>
    <p v-if="effortError" class="ff-error pc-error">⚠ {{ effortError }}</p>
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
    <div class="ff-row">
      <label class="uc-label">Task budget (tokens)</label>
      <input
        type="number"
        min="20000"
        class="ff-field"
        placeholder="≥ 20000"
        :value="state.taskBudgetTokens ?? ''"
        @input="(e) => set('taskBudgetTokens', numberInput(e))"
      />
      <p class="ff-hint">Presupuesto total de tokens por tarea (beta task-budgets). Mínimo 20000. Requiere un modelo Opus. Sin valor, hereda del global.</p>
    </div>
    <div class="ff-row">
      <label class="uc-label">Thinking budget (tokens)</label>
      <input
        type="number"
        min="1024"
        class="ff-field"
        placeholder="— adaptive (default) —"
        :value="state.thinkingBudgetTokens ?? ''"
        @input="(e) => set('thinkingBudgetTokens', numberInput(e))"
      />
      <p class="ff-hint">Fuerza thinking extendido en modo fijo (en vez de adaptive). Mínimo 1024 y debe quedar por debajo de Max tokens — si no entra, se ignora y usa el default global.</p>
    </div>
    <div class="ff-row">
      <label class="uc-label">Max pause_turn retries</label>
      <input
        type="number"
        min="0"
        max="20"
        class="ff-field"
        placeholder="3"
        :value="state.maxPauseTurnRetries ?? ''"
        @input="(e) => set('maxPauseTurnRetries', numberInput(e))"
      />
      <p class="ff-hint">Reintentos cuando la API pausa un turno largo de server tools/MCP (stop_reason pause_turn) — reenvía el historial sin cambios. Sin valor, hereda del global (default 3); 0 = la primera pausa trunca el run.</p>
    </div>
    <div class="ff-row">
      <label class="uc-label">Max reintentos (429/5xx/529)</label>
      <input
        type="number"
        min="0"
        max="10"
        class="ff-field"
        placeholder="3"
        :value="state.maxRetries ?? ''"
        @input="(e) => set('maxRetries', numberInput(e))"
      />
      <p class="ff-hint">Reintentos con backoff exponencial ante rate limit y errores transitorios del upstream. 400/401/403/404 nunca se reintentan. Sin valor, hereda del global (default 3).</p>
    </div>
    <div class="pc-field pc-field--checkbox">
      <label class="ff-check">
        <input
          type="checkbox"
          :checked="state.retryTruncatedToolUse ?? false"
          @change="(e) => set('retryTruncatedToolUse', checkboxInput(e))"
        />
        Reintentar tool_use cortado por max_tokens
      </label>
      <p class="ff-hint">Si max_tokens corta un tool_use a mitad del JSON, reintenta una vez esa misma request con más tokens en vez de dar el run por truncado.</p>
    </div>
    <div class="pc-field pc-field--checkbox">
      <label class="ff-check">
        <input
          type="checkbox"
          :checked="state.eagerMcpTools ?? false"
          @change="(e) => set('eagerMcpTools', checkboxInput(e))"
        />
        Cargar todas las tools MCP desde el inicio
      </label>
      <p class="ff-hint">Por default las tools de cada servidor MCP van diferidas: el modelo las busca y carga sólo las que necesita, y el catálogo no pesa en cada vuelta. Marcalo para un agente que usa el catálogo entero o cuyo prompt no lo prepara para buscar.</p>
    </div>
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
/* Los campos son del kit (`ff-row` + `uc-label` + `ff-field` + `ff-hint`).
   `.pc-field`/`.pc-label`/`.input` estaban copiados VERBATIM entre este form y
   su hermano, con un radio de 6px que no es token — el design system los
   nombraba como deuda. Queda sólo la grilla, que sí es de estos forms. */
.pc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.85rem;
}
.pc-field--checkbox { justify-content: center; }
.pc-error {
  grid-column: 1 / -1;
  padding: 0.5rem 0.75rem;
  background: var(--red-bg);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
}

.pc-disclosure {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  /* Se toca para abrir el bloque avanzado: --tap-h (R1). */
  min-height: var(--tap-h);
  margin-top: 0.7rem;
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: var(--fs-body-sm);
  font-weight: 500;
  padding: 0;
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
