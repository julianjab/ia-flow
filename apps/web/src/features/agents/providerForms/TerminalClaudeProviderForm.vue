<script setup lang="ts">
import { computed } from 'vue';
import ModelSelect from '@/features/providers/ModelSelect.vue';

// Per-agent providerConfig shape for terminal-based Claude providers
// (tmux-claude, iterm-claude). Mirrors the strict Zod schema in
// apps/server/src/providers/terminal-provider-base.ts.
export interface TerminalClaudeProviderConfig {
  model?: string;
  dangerouslySkipPermissions?: boolean;
}

const props = defineProps<{ modelValue: Record<string, unknown> }>();
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>();

const state = computed<TerminalClaudeProviderConfig>(() => props.modelValue as TerminalClaudeProviderConfig);

function set<K extends keyof TerminalClaudeProviderConfig>(key: K, value: TerminalClaudeProviderConfig[K]) {
  const next: Record<string, unknown> = { ...props.modelValue };
  if (value === undefined || value === null || value === '' || value === false) delete next[key as string];
  else next[key as string] = value;
  emit('update:modelValue', next);
}
</script>

<template>
  <div class="pc-grid">
    <div class="pc-field">
      <label class="pc-label">Model</label>
      <ModelSelect
        :model-value="state.model"
        :allow-empty="true"
        empty-label="— default de Claude CLI —"
        @update:model-value="(v) => set('model', v)"
      />
      <p class="field-hint">Se traduce a <code>--model &lt;value&gt;</code> en el CLI de Claude.</p>
    </div>
    <div class="pc-field">
      <label class="pc-label">
        <input
          type="checkbox"
          :checked="state.dangerouslySkipPermissions === true"
          @change="(e) => set('dangerouslySkipPermissions', (e.target as HTMLInputElement).checked)"
        />
        Dangerously skip permissions
      </label>
      <p class="field-hint">Añade <code>--dangerously-skip-permissions</code>. Solo úsalo en entornos aislados.</p>
    </div>
  </div>
</template>

<style scoped>
.pc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.85rem; }
.pc-field { display: flex; flex-direction: column; gap: 0.35rem; }
.pc-label { font-size: 0.85rem; font-weight: 500; color: var(--fg-mute); }
.field-hint { margin: 0; font-size: 0.75rem; color: var(--fg-dim); }
</style>
