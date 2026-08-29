<script setup lang="ts">
// Qué agent-host está mirando la consola, y cuáles conoce.
//
// El selector es el punto de la consola: con un pool (`remote:*`) hay N
// máquinas registradas, y mirarlas era N pestañas con N tokens. El punto
// verde de cada opción sale de sondear su `/v1/capacity` — "corriendo" acá
// significa que contesta, igual que para el health monitor del server.

import { ref, watch } from 'vue'
import type { AgentHostEntry } from './connection'

const props = defineProps<{
  entries: AgentHostEntry[]
  selected: string
  token: string
  /** url → contesta. Lo llena el sondeo del padre. */
  reachable: Record<string, boolean>
  status: 'ok' | 'error' | 'loading'
  statusText: string
}>()

const emit = defineEmits<{
  select: [url: string]
  connect: [url: string, token: string]
  remove: [url: string]
}>()

const urlDraft = ref(props.selected)
const tokenDraft = ref(props.token)
const adding = ref(false)

watch(
  () => [props.selected, props.token] as const,
  ([url, token]) => {
    urlDraft.value = url
    tokenDraft.value = token
    adding.value = false
  },
)

function startAdding(): void {
  adding.value = true
  urlDraft.value = ''
  tokenDraft.value = ''
}

function dotClass(url: string): string {
  if (url === props.selected) return `dot--${props.status}`
  return props.reachable[url] ? 'dot--ok' : 'dot--off'
}
</script>

<template>
  <header class="bar panel">
    <div class="picker">
      <span class="dot" :class="dotClass(selected)" :title="statusText" />
      <select
        class="picker__select"
        :value="selected"
        @change="emit('select', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="e in entries" :key="e.url" :value="e.url">
          {{ reachable[e.url] === false ? '· ' : '' }}{{ e.url }}
        </option>
      </select>
      <button class="btn btn--ghost" title="agregar otro agent-host" @click="startAdding">+</button>
      <button
        v-if="entries.length > 1"
        class="btn btn--ghost"
        title="olvidar este agent-host"
        @click="emit('remove', selected)"
      >
        ×
      </button>
    </div>

    <div class="edit">
      <input
        v-model="urlDraft"
        class="edit__input edit__input--url"
        placeholder="http://otra-maquina:3002"
        spellcheck="false"
        @keyup.enter="emit('connect', urlDraft, tokenDraft)"
      />
      <input
        v-model="tokenDraft"
        class="edit__input"
        type="password"
        :placeholder="adding ? 'token' : 'token (vacío = el guardado)'"
        spellcheck="false"
        @keyup.enter="emit('connect', urlDraft, tokenDraft)"
      />
      <button class="btn" @click="emit('connect', urlDraft, tokenDraft)">
        {{ adding ? 'agregar' : 'conectar' }}
      </button>
    </div>

    <span class="bar__status">{{ statusText }}</span>
  </header>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.5rem 0.75rem;
  margin-bottom: 1rem;
}
.picker,
.edit {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.edit {
  flex: 1;
}
.dot {
  width: 6px;
  height: 6px;
  flex: none;
  background: var(--fg-dim);
}
.dot--ok {
  background: var(--green);
}
.dot--error,
.dot--off {
  background: var(--danger);
}
.dot--loading {
  background: var(--yellow);
}
.picker__select,
.edit__input {
  height: calc(var(--row-h) + 0.5rem);
  padding: 0 0.5rem;
  background: var(--panel-hi);
  border: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
}
.picker__select {
  max-width: 18rem;
}
.edit__input {
  min-width: 7rem;
}
.edit__input--url {
  flex: 1;
}
.edit__input:focus,
.picker__select:focus {
  outline: none;
  border-color: var(--border-hi);
}
.btn {
  height: calc(var(--row-h) + 0.5rem);
  padding: 0 0.7rem;
}
.bar__status {
  color: var(--fg-mute);
  font-size: var(--fs-body-sm);
  white-space: nowrap;
}
</style>
