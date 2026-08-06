<script setup lang="ts">
// Provider-wide defaults para tmux-claude / iterm-claude. Sirven de fallback
// cuando el agente no define `providerConfig` (ver AgentEditorModal).
// Precedencia efectiva: agent.providerConfig > estos defaults.
import { ref, watch } from 'vue';
import type { TerminalProviderSettings } from '@ia-flow/shared';
import ModelSelect from './ModelSelect.vue';

const props = defineProps<{
  modelValue: TerminalProviderSettings;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: TerminalProviderSettings): void;
}>();

function update<K extends keyof TerminalProviderSettings>(key: K, value: TerminalProviderSettings[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function updateModel(val: string) {
  update('model', val || undefined);
}

function updateMaxTurns(val: string) {
  const n = Number(val);
  update('maxTurns', n > 0 ? n : undefined);
}

// ─── Env vars editor ─────────────────────────────────────────────────────────

interface KV { key: string; value: string }

function recordToKv(record: Record<string, string> | undefined): KV[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}

const pairs = ref<KV[]>(recordToKv(props.modelValue.env));

watch(() => props.modelValue.env, (env) => {
  pairs.value = recordToKv(env);
}, { deep: true });

function toRecord(): Record<string, string> {
  return Object.fromEntries(pairs.value.filter(p => p.key).map(p => [p.key, p.value]));
}

function onEnvChange() {
  update('env', toRecord());
}

function addPair() {
  pairs.value.push({ key: '', value: '' });
}

function removePair(i: number) {
  pairs.value.splice(i, 1);
  update('env', toRecord());
}
</script>

<template>
  <div class="terminal-form">
    <div class="field">
      <label>Model</label>
      <ModelSelect :model-value="modelValue.model" allow-empty @update:model-value="updateModel($event ?? '')" />
    </div>

    <div class="field">
      <label for="terminal-max-turns">Max turns (--max-turns)</label>
      <input
        id="terminal-max-turns"
        type="number"
        min="1"
        :value="modelValue.maxTurns ?? ''"
        placeholder="sin límite"
        @input="updateMaxTurns(($event.target as HTMLInputElement).value)"
      />
    </div>

    <div class="field field-inline">
      <label for="terminal-skip-permissions">
        <input
          id="terminal-skip-permissions"
          type="checkbox"
          :checked="modelValue.dangerouslySkipPermissions ?? false"
          @change="update('dangerouslySkipPermissions', ($event.target as HTMLInputElement).checked)"
        />
        --dangerously-skip-permissions
      </label>
    </div>

    <div class="field-group">
      <span class="group-label">Variables de entorno</span>
      <span class="group-hint">Se exportan antes de ejecutar Claude. Útil para <code>ANTHROPIC_API_KEY</code>, <code>GH_TOKEN</code>, etc.</span>

      <div class="kv-list">
        <div v-for="(pair, i) in pairs" :key="i" class="kv-row">
          <input
            class="kv-input kv-key"
            placeholder="VARIABLE"
            :value="pair.key"
            @input="pair.key = ($event.target as HTMLInputElement).value; onEnvChange()"
          />
          <span class="kv-eq">=</span>
          <input
            class="kv-input kv-val"
            placeholder="valor"
            :value="pair.value"
            @input="pair.value = ($event.target as HTMLInputElement).value; onEnvChange()"
          />
          <button type="button" class="btn-remove" title="Eliminar" @click="removePair(i)">✕</button>
        </div>
      </div>

      <button type="button" class="btn-add-kv" @click="addPair">+ Agregar variable</button>
    </div>
  </div>
</template>

<style scoped>
.terminal-form {
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
  font-size: 0.84rem;
}
.field input[type='text'],
.field input[type='number'] {
  flex: 1;
  padding: 0.35rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 0.84rem;
}
.field input[type='text']:focus,
.field input[type='number']:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}
.field-inline label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  font-size: 0.84rem;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-top: 0.5rem;
  border-top: 1px solid #f3f4f6;
  margin-top: 0.25rem;
}
.group-label { font-size: 0.8rem; font-weight: 600; color: #374151; }
.group-hint { font-size: 0.72rem; color: #6b7280; }
.group-hint code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.7rem; }

.kv-list { display: flex; flex-direction: column; gap: 0.4rem; }
.kv-row { display: flex; align-items: center; gap: 0.35rem; }
.kv-input {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 0.35rem 0.5rem;
  font-size: 0.78rem;
  font-family: monospace;
  background: #fff;
  color: #111827;
  outline: none;
}
.kv-input:focus { border-color: #6366f1; }
.kv-key { width: 10rem; }
.kv-val { flex: 1; }
.kv-eq { font-weight: 600; color: #6b7280; font-size: 0.85rem; }
.btn-remove {
  background: none;
  border: none;
  cursor: pointer;
  color: #9ca3af;
  font-size: 0.75rem;
  padding: 0.2rem 0.3rem;
  border-radius: 4px;
  line-height: 1;
}
.btn-remove:hover { color: #ef4444; }
.btn-add-kv {
  align-self: flex-start;
  background: none;
  border: 1px dashed #d1d5db;
  border-radius: 6px;
  padding: 0.3rem 0.6rem;
  font-size: 0.75rem;
  color: #6b7280;
  cursor: pointer;
}
.btn-add-kv:hover { border-color: #6366f1; color: #6366f1; }
</style>
