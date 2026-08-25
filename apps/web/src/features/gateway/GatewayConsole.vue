<script setup lang="ts">
// La consola de los gateways. Reemplaza la página vanilla que cada gateway
// servía (apps/ai-provider-gateway/src/ui.ts, borrada): al vivir acá reusa los
// componentes y el tema de la web, y —lo que la página embebida no podía—
// habla con CUALQUIERA de las máquinas registradas, que es lo que hace falta
// desde que un agente puede ofertar a un pool (`remote:*`).

import { computed, onMounted, onUnmounted, ref } from 'vue'
import GatewayAdmissionCard from './GatewayAdmissionCard.vue'
import GatewayConnectionBar from './GatewayConnectionBar.vue'
import GatewayLogsCard from './GatewayLogsCard.vue'
import GatewayProviderCard from './GatewayProviderCard.vue'
import GatewayServersCard from './GatewayServersCard.vue'
import GatewayWorkspaceCard from './GatewayWorkspaceCard.vue'
import {
  type GatewayAdmission,
  type GatewayCapacity,
  type GatewayLogTail,
  type GatewayProvider,
  type GatewayRegistration,
  type GatewayWorkspace,
  addRegistration,
  fetchAdmission,
  fetchCapacity,
  fetchLogs,
  fetchProvider,
  fetchRegistrations,
  fetchWorkspace,
  gatewayClient,
  gatewayErrorMessage,
  removeRegistration,
  saveAdmission,
  saveWorkspace,
  setProvider,
} from './api'
import {
  type GatewayEntry,
  listGateways,
  removeGateway,
  resolveGateway,
  selectGateway,
  upsertGateway,
} from './connection'

const entries = ref<GatewayEntry[]>([])
const current = ref<GatewayEntry>(resolveGateway())
const reachable = ref<Record<string, boolean>>({})

const status = ref<'ok' | 'error' | 'loading'>('loading')
const statusText = ref('conectando…')
const saving = ref<string | null>(null)
const logQuery = ref('')

const provider = ref<GatewayProvider | null>(null)
const capacity = ref<GatewayCapacity | null>(null)
const admission = ref<GatewayAdmission | null>(null)
const workspace = ref<GatewayWorkspace | null>(null)
const registrations = ref<GatewayRegistration[]>([])
const logs = ref<GatewayLogTail | null>(null)

const client = computed(() => gatewayClient(current.value.url, current.value.token))

function syncEntries(): void {
  entries.value = listGateways()
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
    statusText.value = gatewayErrorMessage(err)
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
        await fetchCapacity(gatewayClient(e.url, e.token))
        next[e.url] = true
      } catch {
        next[e.url] = false
      }
    }),
  )
  reachable.value = next
}

function connect(url: string, token: string): void {
  current.value = upsertGateway(url, token)
  syncEntries()
  void refresh()
  void probeAll()
}

function select(url: string): void {
  selectGateway(url)
  current.value = entries.value.find((e) => e.url === url) ?? current.value
  void refresh()
}

function forget(url: string): void {
  removeGateway(url)
  syncEntries()
  current.value = resolveGateway()
  void refresh()
}

function filterLogs(q: string): void {
  logQuery.value = q
  void refresh()
}

/** Toda escritura vuelve a leer: el gateway puede normalizar lo que mandamos
 *  (recorta, descarta reglas inválidas) y la pantalla debe mostrar lo que
 *  quedó guardado, no lo que creímos guardar. */
async function withSave(key: string, fn: () => Promise<unknown>): Promise<void> {
  saving.value = key
  try {
    await fn()
    await refresh()
  } catch (err) {
    status.value = 'error'
    statusText.value = gatewayErrorMessage(err)
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
  // La ocupación cambia sola (otros daemons despachan a este gateway): sin
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
    <GatewayConnectionBar
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
      <GatewayProviderCard
        :provider="provider"
        :capacity="capacity"
        :saving="saving === 'provider'"
        @select="(id) => withSave('provider', () => setProvider(client, id))"
      />
      <GatewayWorkspaceCard
        :model-value="workspace"
        :saving="saving === 'workspace'"
        @save="(ws) => withSave('workspace', () => saveWorkspace(client, ws))"
      />
      <GatewayAdmissionCard
        :model-value="admission"
        :saving="saving === 'admission'"
        @save="(a) => withSave('admission', () => saveAdmission(client, a))"
      />
      <GatewayServersCard
        :registrations="registrations"
        :saving="saving === 'servers'"
        @add="(u) => withSave('servers', () => addRegistration(client, u))"
        @remove="(u) => withSave('servers', () => removeRegistration(client, u))"
      />
      <GatewayLogsCard :tail="logs" @query="filterLogs" />
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
