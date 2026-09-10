<script setup lang="ts">
// El system prompt propio de ESTA máquina — se antepone al que ya arma cada
// agente (ver apps/agent-host/src/app.ts, withGatewaySystemPrompt), así que
// aplica a CUALQUIER run que aterrice acá sin que el daemon que despachó
// tenga que saber que existe.
//
// Sin catálogo acá a propósito: el agent-host no tiene DB (ver
// apps/agent-host/CLAUDE.md si existiera / el comentario de AgentHostState.
// systemPrompt) — sólo texto inline, mismo `SystemPromptBlock` que ya usa
// AnthropicApiSettingsSchema.systemPrompt del lado del provider LOCAL.

import { ref, watch } from 'vue'
import type { SystemPromptBlock } from '@ia-flow/shared'

const props = defineProps<{ modelValue: SystemPromptBlock[] | null; saving: boolean }>()
const emit = defineEmits<{ save: [value: SystemPromptBlock[]] }>()

const form = ref<string[]>([])

/** Mismo motivo que AgentHostWorkspaceCard: el console re-lee cada 5s y
 *  entrega un array NUEVO cada vuelta — re-sembrar siempre borraría lo que
 *  el usuario está tipeando. */
let seeded: string | null = null

watch(
  () => props.modelValue,
  (next) => {
    if (!next) return
    const snapshot = JSON.stringify(next)
    if (snapshot === seeded) return
    seeded = snapshot
    form.value = next.map((b) => b.text)
  },
  { immediate: true },
)

function setText(index: number, text: string): void {
  form.value[index] = text
}

function removeBlock(index: number): void {
  form.value = form.value.filter((_, i) => i !== index)
}

function addBlock(): void {
  form.value = [...form.value, '']
}

function save(): void {
  // Bloques vacíos se descartan al guardar, no al tipear — si no, borrar el
  // último caracter de un bloque a medio escribir lo haría desaparecer.
  const blocks: SystemPromptBlock[] = form.value
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ type: 'text' as const, text }))
  emit('save', blocks)
}
</script>

<template>
  <section class="panel">
    <header class="panel__header">system prompt</header>
    <div class="body">
      <p class="hint">
        Se antepone al que ya arma cada agente — describe cómo correr en ESTA máquina (una VM
        efímera sin red de salida, un toolchain particular), no qué hacer con la tarea.
      </p>

      <div class="blocks">
        <div v-for="(text, i) in form" :key="i" class="block">
          <textarea
            class="field__textarea"
            rows="3"
            :value="text"
            placeholder="Estás corriendo en una VM efímera de CI, sin red de salida…"
            spellcheck="false"
            @input="setText(i, ($event.target as HTMLTextAreaElement).value)"
          />
          <button
            type="button"
            class="btn btn--drop"
            title="Quitar bloque"
            @click="removeBlock(i)"
          >
            ✕
          </button>
        </div>
        <button type="button" class="btn btn--add" @click="addBlock">+ bloque</button>
      </div>

      <button class="btn btn--primary" :disabled="saving" @click="save">
        {{ saving ? 'guardando…' : 'guardar' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.body {
  padding: 0.75rem;
}
.hint {
  margin: 0 0 0.75rem;
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
}
.blocks {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.block {
  display: flex;
  gap: 0.4rem;
  align-items: flex-start;
}
.field__textarea {
  flex: 1;
  min-width: 0;
  padding: 0.5rem;
  background: var(--panel-hi);
  border: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  resize: vertical;
}
.field__textarea:focus {
  outline: none;
  border-color: var(--border-hi);
}
.btn--drop {
  flex: none;
  height: var(--tap-h);
  width: var(--tap-h);
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--fg-dim);
  cursor: pointer;
}
.btn--add {
  align-self: flex-start;
  height: var(--tap-h);
  padding: 0 0.75rem;
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--fg-dim);
  cursor: pointer;
  font-size: var(--fs-body-sm);
}
</style>
