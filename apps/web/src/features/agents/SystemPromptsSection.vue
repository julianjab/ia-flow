<script setup lang="ts">
// "System Prompts" section of the agent editor — antes vivía como un bloque
// más adentro de "Definición"; se separó para que elegir QUÉ system prompts
// adjunta el agente no compita por espacio con su propio prompt (ver
// AgentEditorModal, que ahora la monta como rail-item propio).
//
// Dos fuentes distintas de `AgentDefinition.systemPrompts`, y las dos se
// editan acá (ver SystemPromptRefSchema en @ia-flow/shared):
//   - ids del catálogo  → chips tildables contra `availableSysprompts`.
//   - bloques `{text}`  → el único formato que funciona en un deploy headless
//     (setPreloadedConfig no manda el catálogo, ver project.yaml de un
//     runner), así que antes de esto quedaban invisibles en el editor
//     aunque SÍ se aplicaran en runtime — se preservaban al guardar pero
//     nunca se mostraban.

import type { SystemPromptDef } from '@ia-flow/shared'

const props = defineProps<{
  selectedSysprompts: string[]
  availableSysprompts: SystemPromptDef[]
  inlinePrompts: string[]
}>()

const emit = defineEmits<{
  'update:selectedSysprompts': [value: string[]]
  'update:inlinePrompts': [value: string[]]
}>()

function toggleSysprompt(id: string) {
  const next = props.selectedSysprompts.includes(id)
    ? props.selectedSysprompts.filter((s) => s !== id)
    : [...props.selectedSysprompts, id]
  emit('update:selectedSysprompts', next)
}

function setInlineText(index: number, text: string) {
  const next = [...props.inlinePrompts]
  next[index] = text
  emit('update:inlinePrompts', next)
}

function removeInline(index: number) {
  emit('update:inlinePrompts', props.inlinePrompts.filter((_, i) => i !== index))
}

function addInline() {
  emit('update:inlinePrompts', [...props.inlinePrompts, ''])
}
</script>

<template>
  <div class="sps">
    <div v-if="availableSysprompts.length" class="field">
      <span class="label">Del catálogo</span>
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
      Sin catálogo — vacío en cualquier deploy headless (no viaja `systemPrompts` en el
      preload), o creá uno en General → System Prompts si este es un deploy con DB.
    </p>

    <div class="field">
      <div class="inline-head">
        <span class="label">Bloques inline</span>
        <button type="button" class="btn-add" @click="addInline">+ Agregar bloque</button>
      </div>
      <span class="field-hint">
        Texto suelto (<code>{ text: ... }</code>), sin id de catálogo — la única forma que
        funciona en un deploy headless. Se manda tal cual, en el orden de la lista, antes de
        los del catálogo.
      </span>
      <div v-if="inlinePrompts.length" class="inline-list">
        <div v-for="(text, i) in inlinePrompts" :key="i" class="inline-block">
          <textarea
            class="inline-textarea"
            rows="4"
            :value="text"
            placeholder="Texto del system prompt…"
            @input="setInlineText(i, ($event.target as HTMLTextAreaElement).value)"
          />
          <button type="button" class="btn-remove" title="Quitar bloque" @click="removeInline(i)">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sps { display: flex; flex-direction: column; gap: 1.1rem; }

.field { display: flex; flex-direction: column; gap: 0.3rem; }
.label { font-size: 0.82rem; font-weight: 600; color: var(--fg-mute); }
.field-hint { font-size: 0.73rem; color: var(--fg-dim); line-height: 1.4; }
.field-hint code { background: var(--panel-hi); padding: 0.1rem 0.3rem; font-size: 0.7rem; }

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

.inline-head { display: flex; align-items: center; justify-content: space-between; }
.btn-add {
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--border-hi);
  background: var(--panel);
  font-size: 0.72rem;
  color: var(--fg-mute);
  cursor: pointer;
}
.btn-add:hover { border-color: var(--info); color: var(--info); }

.inline-list { display: flex; flex-direction: column; gap: 0.5rem; }
.inline-block { display: flex; gap: 0.4rem; align-items: flex-start; }
.inline-textarea {
  flex: 1;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border-hi);
  font-size: 0.82rem;
  font-family: var(--font-mono);
  color: var(--fg);
  background: var(--panel);
  resize: vertical;
  box-sizing: border-box;
  outline: none;
}
.inline-textarea:focus { border-color: var(--accent); }
.btn-remove {
  flex-shrink: 0;
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border-hi);
  background: var(--panel);
  font-size: 0.75rem;
  color: var(--fg-dim);
  cursor: pointer;
}
.btn-remove:hover { border-color: var(--danger); color: var(--danger); }
</style>
