<script setup lang="ts">
// "System Prompts" section of the agent editor — antes vivía como un bloque
// más adentro de "Definición"; se separó para que elegir QUÉ system prompts
// adjunta el agente no compita por espacio con su propio prompt (ver
// AgentEditorModal, que ahora la monta como rail-item propio).

import type { SystemPromptDef } from '@ia-flow/shared'

const props = defineProps<{
  selectedSysprompts: string[]
  availableSysprompts: SystemPromptDef[]
}>()

const emit = defineEmits<{
  'update:selectedSysprompts': [value: string[]]
}>()

function toggleSysprompt(id: string) {
  const next = props.selectedSysprompts.includes(id)
    ? props.selectedSysprompts.filter((s) => s !== id)
    : [...props.selectedSysprompts, id]
  emit('update:selectedSysprompts', next)
}
</script>

<template>
  <div class="sps">
    <div v-if="availableSysprompts.length" class="field">
      <span class="label">System Prompts</span>
      <span class="field-hint">Sin selección = ninguno extra.</span>
      <div class="chip-grid">
        <label
          v-for="sp in availableSysprompts"
          :key="sp.id"
          class="chip"
          :class="{ active: selectedSysprompts.includes(sp.id) }"
          :title="sp.text"
          @click="toggleSysprompt(sp.id)"
        >
          <span class="chip-check">{{ selectedSysprompts.includes(sp.id) ? '✓' : '' }}</span>
          <span>{{ sp.name }}</span>
        </label>
      </div>
    </div>
    <p v-else class="field-hint">
      No hay system prompts definidos todavía — creá uno en General → System Prompts.
    </p>
  </div>
</template>

<style scoped>
.sps { display: flex; flex-direction: column; gap: 1.1rem; }

.field { display: flex; flex-direction: column; gap: 0.3rem; }
.label { font-size: 0.82rem; font-weight: 600; color: var(--fg-mute); }
.field-hint { font-size: 0.73rem; color: var(--fg-dim); line-height: 1.4; }

.chip-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.chip {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.65rem;
  border: 1px solid var(--border-hi);
  font-size: 0.78rem;
  color: var(--fg-mute);
  cursor: pointer;
  user-select: none;
  background: var(--panel);
  transition: border-color 0.1s, background 0.1s;
}
.chip:hover { border-color: var(--info); color: var(--info); }
.chip.active { border-color: var(--info); background: var(--panel-hi); color: var(--info); font-weight: 500; }
.chip-check { width: 0.8rem; font-size: 0.72rem; color: var(--info); }
</style>
