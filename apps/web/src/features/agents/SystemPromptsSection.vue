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
    <div v-if="availableSysprompts.length" class="ff-row">
      <span class="uc-label">Del catálogo</span>
      <div class="ff-chips">
        <label
          v-for="sp in availableSysprompts"
          :key="sp.id"
          class="ff-chip"
          :class="{ 'ff-chip--on': selectedSysprompts.includes(sp.id) }"
          :title="sp.text"
          @click="toggleSysprompt(sp.id)"
        >
          <span class="ff-chip-check">{{ selectedSysprompts.includes(sp.id) ? '✓' : '' }}</span>
          <span>{{ sp.name }}</span>
        </label>
      </div>
      <!-- El hint dice la consecuencia, no el nombre (R21): "sin selección"
           ya se ve en los chips; lo que no se adivina es el orden en que se
           concatenan y contra qué. -->
      <p class="ff-hint">Se concatenan en este orden, antes del prompt del agente.</p>
    </div>
    <p v-else class="ff-hint">
      Sin catálogo — vacío en cualquier deploy headless (no viaja `systemPrompts` en el
      preload), o creá uno en General → System Prompts si este es un deploy con DB.
    </p>

    <div class="ff-row">
      <span class="uc-label">Bloques inline</span>
      <p class="ff-hint">
        Texto suelto (<code>{ text: ... }</code>), sin id de catálogo — la única forma que
        funciona en un deploy headless. Se manda tal cual, después de los del catálogo.
      </p>
      <!-- `+ bloque` es la última fila de la lista, no un botón en el
           encabezado (R11): el gesto de agregar queda donde termina lo que se
           está leyendo, y no se mueve de lugar cuando la lista crece. -->
      <div class="ff-list">
        <div v-for="(text, i) in inlinePrompts" :key="i" class="inline-block">
          <textarea
            class="ff-field ff-textarea ff-mono"
            rows="4"
            :value="text"
            placeholder="Texto del system prompt…"
            @input="setInlineText(i, ($event.target as HTMLTextAreaElement).value)"
          />
          <button type="button" class="ff-drop" title="Quitar bloque" @click="removeInline(i)">✕</button>
        </div>
        <button type="button" class="ff-add" @click="addInline">+ bloque</button>
      </div>
    </div>
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
.sps { display: flex; flex-direction: column; gap: 0.9rem; }

/* El ✕ se alinea al TOPE del textarea, no al centro: un bloque de cuatro
   filas y otro de veinte dejarían el control de borrar a alturas distintas. */
.inline-block { display: flex; gap: 0.4rem; align-items: flex-start; }
.inline-block > .ff-drop { margin-top: 0.55rem; }
</style>
