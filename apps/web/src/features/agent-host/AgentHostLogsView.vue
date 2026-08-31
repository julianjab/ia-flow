<script setup lang="ts">
// Los logs del agent-host elegido, a pantalla completa.
//
// La tarjeta (`AgentHostLogsCard`) existía dentro de la grilla de la consola,
// compitiendo por ancho con provider, workspace, admisión y servers. Es la
// única ventana a lo que pasa en esa máquina cuando se levanta desde el Finder
// y su stdout no lo ve nadie, así que merece la pantalla entera — y una entrada
// propia en el menú, al lado de `logs` del server, que es donde el operador ya
// la busca.
//
// El renderer se reusa tal cual: la diferencia es el ancho y el refresco, no
// cómo se dibuja una línea.

import { onMounted, onUnmounted, ref } from 'vue'
import AgentHostLogsCard from './AgentHostLogsCard.vue'
import { type AgentHostLogTail, agentHostErrorMessage, fetchLogs } from './api'
import { isAgentHostSelected, selectedAgentHostClient } from './connection'

const selected = isAgentHostSelected()
const tail = ref<AgentHostLogTail | null>(null)
const error = ref('')
const query = ref('')

async function refresh(): Promise<void> {
  try {
    tail.value = await fetchLogs(selectedAgentHostClient(), query.value)
    error.value = ''
  } catch (err) {
    error.value = agentHostErrorMessage(err)
  }
}

function filter(q: string): void {
  query.value = q
  void refresh()
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  if (!selected) return
  void refresh()
  // Un log que no avanza solo obliga a recargar para ver si algo pasó, que es
  // justo lo que uno está mirando cuando abre esta pantalla.
  timer = setInterval(() => void refresh(), 5_000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <main class="wrap">
    <p v-if="!selected" class="hint">
      · lo que estás mirando no es un agent-host —
      <RouterLink to="/servers">elegí uno en la lista de servers</RouterLink>
    </p>

    <template v-else>
      <p v-if="error" class="err">· {{ error }}</p>
      <AgentHostLogsCard :tail="tail" @query="filter" />
    </template>
  </main>
</template>

<style scoped>
.wrap {
  padding: 1.5rem;
}
.hint { color: var(--fg-dim); }
.err { color: var(--danger); font-size: 0.85rem; }
</style>
