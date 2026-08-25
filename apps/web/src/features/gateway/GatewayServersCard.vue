<script setup lang="ts">
// Contra qué servers de ia-flow se da de alta este gateway.
//
// Es lo que resuelve el huevo-gallina: se configura desde acá, apuntando
// directo al gateway, sin que ningún server tenga que conocerlo todavía.

import { ref } from 'vue'
import type { GatewayRegistration } from './api'

defineProps<{ registrations: GatewayRegistration[]; saving: boolean }>()
const emit = defineEmits<{ add: [serverUrl: string]; remove: [serverUrl: string] }>()

const draft = ref('')

function add(): void {
  const url = draft.value.trim()
  if (!url) return
  emit('add', url)
  draft.value = ''
}
</script>

<template>
  <section class="panel">
    <header class="panel__header">servers</header>
    <div class="body">
      <p class="hint">Dónde se anuncia este gateway al arrancar.</p>

      <ul v-if="registrations.length" class="list">
        <li v-for="r in registrations" :key="r.serverUrl" class="list__item">
          <span class="dot" :class="r.ok ? 'dot--ok' : 'dot--err'" />
          <code class="list__url">{{ r.serverUrl }}</code>
          <span v-if="!r.ok" class="list__err" :title="r.error">{{ r.error ?? 'sin alta' }}</span>
          <button
            class="btn btn--ghost list__rm"
            :disabled="saving"
            title="quitar"
            @click="emit('remove', r.serverUrl)"
          >
            ×
          </button>
        </li>
      </ul>
      <p v-else class="hint">· no registrado en ningún server</p>

      <div class="new">
        <input
          v-model="draft"
          class="new__input"
          placeholder="http://localhost:3001"
          spellcheck="false"
          @keyup.enter="add"
        />
        <button class="btn" :disabled="saving" @click="add">agregar</button>
      </div>
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
.list {
  list-style: none;
  margin: 0 0 0.75rem;
  padding: 0;
}
.list__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: calc(var(--row-h) + 0.5rem);
  padding: 0 0.5rem;
  border: 1px solid var(--border);
  margin-bottom: 0.25rem;
  font-size: var(--fs-body-sm);
}
.list__url {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono);
}
.list__err {
  color: var(--danger);
  font-size: var(--fs-micro);
}
.list__rm {
  height: var(--row-h);
  padding: 0 0.4rem;
}
.dot {
  width: 6px;
  height: 6px;
  flex: none;
}
.dot--ok {
  background: var(--green);
}
.dot--err {
  background: var(--danger);
}
.new {
  display: flex;
  gap: 0.4rem;
}
.new__input {
  flex: 1;
  height: calc(var(--row-h) + 0.5rem);
  padding: 0 0.5rem;
  background: var(--panel-hi);
  border: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
}
</style>
