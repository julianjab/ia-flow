<script setup lang="ts">
// Los runs en vuelo del agent-host elegido, a pantalla completa. Mismo trato
// que AgentHostLogsView: ruta top-level propia (no un tab más), con su propio
// poll de 5s — es lo que responde "¿esta máquina está haciendo algo ahora?"
// sin tener que ir a buscarlo al daemon que la despachó.

import { onMounted, onUnmounted, ref } from 'vue'
import AgentHostRunsCard from './AgentHostRunsCard.vue'
import { type AgentHostRun, agentHostErrorMessage, fetchRuns } from './api'
import { isAgentHostSelected, selectedAgentHostClient } from './connection'

const selected = isAgentHostSelected()
const running = ref<number | null>(null)
const runs = ref<AgentHostRun[] | null>(null)
const error = ref('')
const loading = ref(false)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const fresh = await fetchRuns(selectedAgentHostClient())
    running.value = fresh.running
    runs.value = fresh.runs
    error.value = ''
  } catch (err) {
    error.value = agentHostErrorMessage(err)
  } finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  if (!selected) return
  void refresh()
  timer = setInterval(() => {
    if (!loading.value) void refresh()
  }, 5_000)
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
      <AgentHostRunsCard :running="running" :runs="runs" />
    </template>
  </main>
</template>

<style scoped>
.wrap {
  padding: 1.5rem;
}
.hint { color: var(--fg-dim); font-size: var(--fs-body-sm); }
.err { color: var(--danger); font-size: var(--fs-body-sm); }
</style>
