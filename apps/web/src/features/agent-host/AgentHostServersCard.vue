<script setup lang="ts">
// Contra qué servers de ia-flow se da de alta este agent-host.
//
// Es lo que resuelve el huevo-gallina: se configura desde acá, apuntando
// directo al agent-host, sin que ningún server tenga que conocerlo todavía.

import { ref } from 'vue'
import type { AgentHostRegistration } from './api'

defineProps<{ registrations: AgentHostRegistration[]; saving: boolean }>()
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
      <p class="hint">Dónde se anuncia este agent-host al arrancar.</p>

      <ul v-if="registrations.length" class="list">
        <li v-for="r in registrations" :key="r.serverUrl" class="list__item">
          <span class="dot" :class="r.ok ? 'dot--ok' : 'dot--err'" />
          <code class="list__url">{{ r.serverUrl }}</code>
          <span v-if="r.ok && r.publicUrl" class="list__via" :title="`me alcanza en ${r.publicUrl}`">
            me alcanza en {{ r.publicUrl }}
          </span>
          <span v-if="!r.ok" class="list__err" :title="r.reason">{{ r.reason ?? 'sin alta' }}</span>
          <button
            class="btn btn--ghost"
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
          class="ff-field ff-mono new__input"
          placeholder="http://localhost:3001"
          spellcheck="false"
          @keyup.enter="add"
        />
        <button class="btn" :disabled="saving" @click="add">agregar</button>
      </div>
    </div>
  </section>
</template>

<style scoped src="@/ui/form-fields.css" />
<style scoped>
.body {
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.hint {
  margin: 0;
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.list__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: var(--tap-h);
  padding: 0 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
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
.list__via {
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.dot--ok {
  background: var(--accent);
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
}
</style>
