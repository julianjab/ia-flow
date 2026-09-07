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
    <div class="ff-row">
      <label class="uc-label">Model</label>
      <ModelSelect
        :model-value="state.model"
        :allow-empty="true"
        empty-label="— default de Claude CLI —"
        @update:model-value="(v) => set('model', v)"
      />
      <p class="ff-hint">Se traduce a <code>--model &lt;value&gt;</code> en el CLI de Claude.</p>
    </div>
    <div class="ff-row">
      <label class="uc-label">
        <input
          type="checkbox"
          :checked="state.dangerouslySkipPermissions === true"
          @change="(e) => set('dangerouslySkipPermissions', (e.target as HTMLInputElement).checked)"
        />
        Dangerously skip permissions
      </label>
      <p class="ff-hint">Añade <code>--dangerously-skip-permissions</code>. Solo úsalo en entornos aislados.</p>
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
</style>
