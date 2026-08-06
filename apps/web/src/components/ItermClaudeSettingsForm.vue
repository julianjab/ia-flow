<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ItermClaudeSettings } from '@ia-flow/shared';

const props = defineProps<{
  modelValue: ItermClaudeSettings;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: ItermClaudeSettings): void;
}>();

interface KV { key: string; value: string }

function recordToKv(record: Record<string, string> | undefined): KV[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}

const pairs = ref<KV[]>(recordToKv(props.modelValue.env));

watch(() => props.modelValue.env, (env) => {
  pairs.value = recordToKv(env);
}, { deep: true });

function addPair() {
  pairs.value.push({ key: '', value: '' });
}

function removePair(i: number) {
  pairs.value.splice(i, 1);
  emit('update:modelValue', { ...props.modelValue, env: toRecord() });
}

function toRecord(): Record<string, string> {
  return Object.fromEntries(pairs.value.filter(p => p.key).map(p => [p.key, p.value]));
}

function onChange() {
  emit('update:modelValue', { ...props.modelValue, env: toRecord() });
}
</script>

<template>
  <div class="iterm-settings">
    <div class="field">
      <span class="label">Variables de entorno</span>
      <span class="field-hint">
        Se exportan antes de ejecutar Claude en cada tab de iTerm2.
        Útil para <code>ANTHROPIC_API_KEY</code>, <code>GH_TOKEN</code>, etc.
      </span>

      <div class="kv-list">
        <div v-for="(pair, i) in pairs" :key="i" class="kv-row">
          <input
            class="input kv-key"
            placeholder="VARIABLE"
            :value="pair.key"
            @input="pair.key = ($event.target as HTMLInputElement).value; onChange()"
          />
          <span class="kv-eq">=</span>
          <input
            class="input kv-val"
            placeholder="valor"
            :value="pair.value"
            @input="pair.value = ($event.target as HTMLInputElement).value; onChange()"
          />
          <button type="button" class="btn-remove" @click="removePair(i)" title="Eliminar">✕</button>
        </div>
      </div>

      <button type="button" class="btn-add" @click="addPair">+ Agregar variable</button>
    </div>
  </div>
</template>

<style scoped>
.iterm-settings { display: flex; flex-direction: column; gap: 0.75rem; }

.field { display: flex; flex-direction: column; gap: 0.35rem; }
.label { font-size: 0.8rem; font-weight: 600; color: #374151; }
.field-hint { font-size: 0.72rem; color: #6b7280; }
.field-hint code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.7rem; }

.kv-list { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.25rem; }

.kv-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.input {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 0.35rem 0.5rem;
  font-size: 0.78rem;
  font-family: monospace;
  background: #fff;
  color: #111827;
  outline: none;
  transition: border-color 0.15s;
}
.input:focus { border-color: #6366f1; }

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
  transition: color 0.15s;
}
.btn-remove:hover { color: #ef4444; }

.btn-add {
  align-self: flex-start;
  margin-top: 0.25rem;
  background: none;
  border: 1px dashed #d1d5db;
  border-radius: 6px;
  padding: 0.3rem 0.6rem;
  font-size: 0.75rem;
  color: #6b7280;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.btn-add:hover { border-color: #6366f1; color: #6366f1; }
</style>
