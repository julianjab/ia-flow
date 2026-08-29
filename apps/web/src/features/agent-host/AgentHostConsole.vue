<script setup lang="ts">
// La consola de los agent-hosts. Reemplaza la página vanilla que cada agent-host
// servía (apps/agent-host/src/ui.ts, borrada): al vivir acá reusa los
// componentes y el tema de la web, y —lo que la página embebida no podía—
// habla con CUALQUIERA de las máquinas registradas, que es lo que hace falta
// desde que un agente puede ofertar a un pool (`remote:*`).

import { computed, onMounted, onUnmounted, ref } from 'vue'
import AgentHostAdmissionCard from './AgentHostAdmissionCard.vue'
import AgentHostConnectionBar from './AgentHostConnectionBar.vue'
import AgentHostLogsCard from './AgentHostLogsCard.vue'
import AgentHostProviderCard from './AgentHostProviderCard.vue'
import AgentHostServersCard from './AgentHostServersCard.vue'
import AgentHostWorkspaceCard from './AgentHostWorkspaceCard.vue'
import {
  type AgentHostAdmission,
  type AgentHostCapacity,
  type AgentHostLogTail,
  type AgentHostProvider,
  type AgentHostRegistration,
  type AgentHostWorkspace,
  addRegistration,
  fetchAdmission,
  fetchCapacity,
  fetchLogs,
  fetchProvider,
  fetchRegistrations,
  fetchWorkspace,
  agentHostClient,
  agentHostErrorMessage,
  removeRegistration,
  saveAdmission,
  saveWorkspace,
  setProvider,
} from './api'
import {
  type AgentHostEntry,
  listAgentHosts,
  removeAgentHost,
  resolveAgentHost,
  selectAgentHost,
  upsertAgentHost,
} from './connection'

const entries = ref<AgentHostEntry[]>([])
const current = ref<AgentHostEntry>(resolveAgentHost())
const reachable = ref<Record<string, boolean>>({})

const status = ref<'ok' | 'error' | 'loading'>('loading')
const statusText = ref('conectando…')
const saving = ref<string | null>(null)
const logQuery = ref('')

const provider = ref<AgentHostProvider | null>(null)
const capacity = ref<AgentHostCapacity | null>(null)
const admission = ref<AgentHostAdmission | null>(null)
const workspace = ref<AgentHostWorkspace | null>(null)
const registrations = ref<AgentHostRegistration[]>([])
const logs = ref<AgentHostLogTail | null>(null)

const client = computed(() => agentHostClient(current.value.url, current.value.token))

function syncEntries(): void {
  entries.value = listAgentHosts()
}

async function refresh(): Promise<void> {
  status.value = 'loading'
  try {
    const c = client.value
    // En paralelo: son seis lecturas independientes del mismo proceso, y en
    // serie la pantalla tardaría seis round-trips en pintar.
    const [p, cap, adm, ws, regs, tail] = await Promise.all([
      fetchProvider(c),
      fetchCapacity(c),
      fetchAdmission(c),
      fetchWorkspace(c),
      fetchRegistrations(c),
      fetchLogs(c, logQuery.value),
    ])
    provider.value = p
    capacity.value = cap
    admission.value = adm
    workspace.value = ws
    registrations.value = regs.registrations
    logs.value = tail
    status.value = 'ok'
    statusText.value = `${p.name} · ${cap.running} en curso`
    reachable.value = { ...reachable.value, [current.value.url]: true }
  } catch (err) {
    status.value = 'error'
    statusText.value = agentHostErrorMessage(err)
    reachable.value = { ...reachable.value, [current.value.url]: false }
  }
}

/**
 * ¿Cuáles de los conocidos están corriendo?
 *
 * Una sonda barata a `/v1/capacity` de cada uno — el mismo criterio que usa
 * el health monitor del server: "disponible" es "contesta". Alimenta el punto
 * de cada opción del selector, para que elegir no sea adivinar.
 */
async function probeAll(): Promise<void> {
  const next: Record<string, boolean> = {}
  await Promise.all(
    entries.value.map(async (e) => {
      try {
        await fetchCapacity(agentHostClient(e.url, e.token))
        next[e.url] = true
      } catch {
        next[e.url] = false
      }
    }),
  )
  reachable.value = next
}

function connect(url: string, token: string): void {
  current.value = upsertAgentHost(url, token)
  syncEntries()
  void refresh()
  void probeAll()
}

function select(url: string): void {
  selectAgentHost(url)
  current.value = entries.value.find((e) => e.url === url) ?? current.value
  void refresh()
}

function forget(url: string): void {
  removeAgentHost(url)
  syncEntries()
  current.value = resolveAgentHost()
  void refresh()
}

function filterLogs(q: string): void {
  logQuery.value = q
  void refresh()
}

/** Toda escritura vuelve a leer: el agent-host puede normalizar lo que mandamos
 *  (recorta, descarta reglas inválidas) y la pantalla debe mostrar lo que
 *  quedó guardado, no lo que creímos guardar. */
async function withSave(key: string, fn: () => Promise<unknown>): Promise<void> {
  saving.value = key
  try {
    await fn()
    await refresh()
  } catch (err) {
    status.value = 'error'
    statusText.value = agentHostErrorMessage(err)
  } finally {
    saving.value = null
  }
}

let timer: ReturnType<typeof setInterval> | undefined
let probeTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  syncEntries()
  void refresh()
  void probeAll()
  // La ocupación cambia sola (otros daemons despachan a este agent-host): sin
  // refresco, "0 en curso" quedaría mintiendo hasta que alguien recargue.
  timer = setInterval(() => {
    if (status.value !== 'loading') void refresh()
  }, 5_000)
  // El resto del pool se sondea más espaciado: sólo alimenta un punto de
  // color, y son N requests por vuelta.
  probeTimer = setInterval(() => void probeAll(), 20_000)
})
onUnmounted(() => {
  clearInterval(timer)
  clearInterval(probeTimer)
})
</script>

<template>
  <main class="wrap">
    <AgentHostConnectionBar
      :entries="entries"
      :selected="current.url"
      :token="current.token"
      :reachable="reachable"
      :status="status"
      :status-text="statusText"
      @select="select"
      @connect="connect"
      @remove="forget"
    />

    <div class="grid">
      <AgentHostProviderCard
        :provider="provider"
        :capacity="capacity"
        :saving="saving === 'provider'"
        @select="(id) => withSave('provider', () => setProvider(client, id))"
      />
      <AgentHostWorkspaceCard
        :model-value="workspace"
        :saving="saving === 'workspace'"
        @save="(ws) => withSave('workspace', () => saveWorkspace(client, ws))"
      />
      <AgentHostAdmissionCard
        :model-value="admission"
        :saving="saving === 'admission'"
        @save="(a) => withSave('admission', () => saveAdmission(client, a))"
      />
      <AgentHostServersCard
        :registrations="registrations"
        :saving="saving === 'servers'"
        @add="(u) => withSave('servers', () => addRegistration(client, u))"
        @remove="(u) => withSave('servers', () => removeRegistration(client, u))"
      />
      <AgentHostLogsCard :tail="logs" @query="filterLogs" />
    </div>
  </main>
</template>

<style scoped>
.wrap {
  max-width: 60rem;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr));
  gap: 1rem;
  align-items: start;
}
</style>
