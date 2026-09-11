<script setup lang="ts">
// El system prompt propio de ESTA máquina — se antepone al que ya arma cada
// agente (ver apps/agent-host/src/app.ts, withGatewaySystemPrompt), así que
// aplica a CUALQUIER run que aterrice acá sin que el daemon que despachó
// tenga que saber que existe.
//
// Sin catálogo acá a propósito: el agent-host no tiene DB (ver
// AgentHostState.systemPrompt) — sólo texto inline, mismo `SystemPromptBlock`
// que ya usa AnthropicApiSettingsSchema.systemPrompt del lado del provider
// LOCAL.

import type { SystemPromptBlock } from '@ia-flow/shared'
import { ref, watch } from 'vue'

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
  <section class="settings-section">
    <div class="section-header">
      <div class="section-head-text">
        <h2>system prompt</h2>
        <p class="section-desc">
          Se antepone al que ya arma cada agente — describe cómo correr en ESTA máquina (una VM
          efímera sin red de salida, un toolchain particular), no qué hacer con la tarea.
        </p>
      </div>
    </div>
    <div class="body">
      <div class="ff-list">
        <div v-for="(text, i) in form" :key="i" class="ff-list-row block">
          <textarea
            class="ff-field ff-textarea ff-mono"
            rows="3"
            :value="text"
            placeholder="Estás corriendo en una VM efímera de CI, sin red de salida…"
            spellcheck="false"
            @input="setText(i, ($event.target as HTMLTextAreaElement).value)"
          />
          <button type="button" class="ff-drop" title="Quitar bloque" @click="removeBlock(i)">
            ✕
          </button>
        </div>
        <button type="button" class="ff-add" @click="addBlock">+ bloque</button>
      </div>

      <button class="btn btn--primary save" :disabled="saving" @click="save">
        {{ saving ? 'guardando…' : 'guardar' }}
      </button>
    </div>
  </section>
</template>

<style scoped src="@/ui/form-fields.css" />
<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.block {
  align-items: flex-start;
}
.save {
  align-self: flex-start;
}
</style>
