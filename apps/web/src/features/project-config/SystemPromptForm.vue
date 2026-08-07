<script setup lang="ts">
import { onMounted, ref } from 'vue';
import PromptField from '@/features/prompts/PromptField.vue';
import type { VariableGroup } from '@/features/prompts/PromptField.vue';
import type { VariableDefinition } from '@ia-flow/shared';
import { formatVariable } from '@ia-flow/shared';

export interface SystemPromptDraft {
  name: string;
  text: string;
}

const props = defineProps<{
  modelValue: SystemPromptDraft;
  idHint?: string;
  variant?: 'new' | 'edit';
}>();

const emit = defineEmits<{
  'update:modelValue': [value: SystemPromptDraft];
  save: [];
  cancel: [];
}>();

const variableGroups = ref<VariableGroup[]>([]);

onMounted(async () => {
  try {
    const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';
    const res = await fetch(`${API_BASE}/api/variables?context=system-prompt`);
    if (res.ok) {
      const defs: VariableDefinition[] = await res.json();
      const byGroup = new Map<string, VariableDefinition[]>();
      for (const v of defs) {
        const g = v.group ?? 'system';
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g)!.push(v);
      }
      variableGroups.value = [...byGroup.entries()].map(([label, items]) => ({
        label,
        items: items.map(v => {
          const formatted = formatVariable(v);
          return { label: formatted, value: formatted, hint: v.description };
        }),
      }));
    }
  } catch { /* server may not be running */ }
});

function updateName(v: string) {
  emit('update:modelValue', { ...props.modelValue, name: v });
}

function updateText(v: string) {
  emit('update:modelValue', { ...props.modelValue, text: v });
}
</script>

<template>
  <div class="sp-form" :class="{ 'sp-form--edit': variant === 'edit' }">
    <div class="field">
      <span class="field-label">Nombre</span>
      <input
        :value="modelValue.name"
        class="input"
        placeholder="Claude Code Identity"
        @input="updateName(($event.target as HTMLInputElement).value)"
      />
      <span v-if="idHint" class="field-hint">id: <code>{{ idHint }}</code></span>
    </div>
    <div class="field" style="margin-top: 0.5rem">
      <PromptField
        :model-value="modelValue.text"
        :rows="4"
        :variable-groups="variableGroups"
        label="Texto"
        @update:model-value="updateText"
      />
    </div>
    <div class="sp-form-actions">
      <button class="btn-cancel-sm" @click="emit('cancel')">Cancelar</button>
      <button class="btn-save-sm" @click="emit('save')">Guardar</button>
    </div>
  </div>
</template>

<style scoped>
.sp-form {
  background: #f8fafc;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem;
  margin-bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.sp-form--edit { border-color: #2563eb; background: #f0f7ff; }
.sp-form-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.25rem; }
.field { display: flex; flex-direction: column; gap: 0.25rem; }
.field-label { font-size: 0.8rem; font-weight: 500; color: #374151; }
.field-hint { font-size: 0.72rem; color: #9ca3af; }
.field-hint code {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  background: #f3f4f6;
  padding: 0.05rem 0.25rem;
  border-radius: 3px;
}
.input {
  padding: 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.84rem;
  color: #1e293b;
  background: #fff;
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
.btn-cancel-sm {
  padding: 0.3rem 0.85rem;
  border: 1px solid #d1d5db;
  border-radius: 5px;
  background: #fff;
  font-size: 0.8rem;
  cursor: pointer;
  color: #374151;
}
.btn-save-sm {
  padding: 0.3rem 0.85rem;
  border: none;
  border-radius: 5px;
  background: #2563eb;
  color: #fff;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-save-sm:hover { background: #1d4ed8; }
</style>
