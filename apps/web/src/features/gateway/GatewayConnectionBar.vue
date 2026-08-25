<script setup lang="ts">
// A qué gateway apunta la consola. Es lo primero de la pantalla porque es lo
// que da sentido a todo lo demás: la misma consola sirve para N máquinas.

import { ref, watch } from 'vue'

const props = defineProps<{
  url: string
  token: string
  status: 'ok' | 'error' | 'loading'
  statusText: string
}>()
const emit = defineEmits<{ connect: [url: string, token: string] }>()

const urlDraft = ref(props.url)
const tokenDraft = ref(props.token)

watch(
  () => [props.url, props.token] as const,
  ([u, t]) => {
    urlDraft.value = u
    tokenDraft.value = t
  },
)
</script>

<template>
  <header class="bar panel">
    <span class="dot" :class="`dot--${status}`" :title="statusText" />
    <input
      v-model="urlDraft"
      class="bar__input bar__input--url"
      placeholder="http://localhost:3002"
      spellcheck="false"
      @keyup.enter="emit('connect', urlDraft, tokenDraft)"
    />
    <input
      v-model="tokenDraft"
      class="bar__input"
      type="password"
      placeholder="token"
      spellcheck="false"
      @keyup.enter="emit('connect', urlDraft, tokenDraft)"
    />
    <button class="btn" @click="emit('connect', urlDraft, tokenDraft)">conectar</button>
    <span class="bar__status">{{ statusText }}</span>
  </header>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 1rem;
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
.dot--error {
  background: var(--danger);
}
.dot--loading {
  background: var(--yellow);
}
.bar__input {
  height: calc(var(--row-h) + 0.5rem);
  padding: 0 0.5rem;
  background: var(--panel-hi);
  border: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  min-width: 8rem;
}
.bar__input--url {
  flex: 1;
}
.bar__input:focus {
  outline: none;
  border-color: var(--border-hi);
}
.bar__status {
  color: var(--fg-mute);
  font-size: var(--fs-body-sm);
  white-space: nowrap;
}
</style>
