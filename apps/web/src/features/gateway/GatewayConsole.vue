<script setup lang="ts">
// La consola de un gateway. Reemplaza la página vanilla que el propio gateway
// servía (apps/ai-provider-gateway/src/ui.ts, borrada): al vivir acá reusa los
// componentes y el tema de la web, y —lo que la página embebida no podía—
// apunta a CUALQUIER gateway, que es lo que hace falta desde que un agente
// puede ofertar a un pool (`remote:*`).

import { computed, onMounted, onUnmounted, ref } from 'vue'
import GatewayAdmissionCard from './GatewayAdmissionCard.vue'
import GatewayConnectionBar from './GatewayConnectionBar.vue'
import GatewayProviderCard from './GatewayProviderCard.vue'
import GatewayServersCard from './GatewayServersCard.vue'
import GatewayWorkspaceCard from './GatewayWorkspaceCard.vue'
import {
  type GatewayAdmission,
  type GatewayCapacity,
  type GatewayProvider,
  type GatewayRegistration,
  type GatewayWorkspace,
  addRegistration,
  fetchAdmission,
  fetchCapacity,
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
import { getToken, resolveGatewayUrl, setGatewayUrl, setToken } from './connection'

const url = ref(resolveGatewayUrl())
const token = ref(getToken())

const status = ref<'ok' | 'error' | 'loading'>('loading')
const statusText = ref('conectando…')
const saving = ref<string | null>(null)

const provider = ref<GatewayProvider | null>(null)
const capacity = ref<GatewayCapacity | null>(null)
const admission = ref<GatewayAdmission | null>(null)
const workspace = ref<GatewayWorkspace | null>(null)
const registrations = ref<GatewayRegistration[]>([])

const client = computed(() => gatewayClient(url.value, token.value))

async function refresh(): Promise<void> {
  status.value = 'loading'
  try {
    const c = client.value
    // En paralelo: son cinco lecturas independientes del mismo proceso, y en
    // serie la pantalla tardaría cinco round-trips en pintar.
    const [p, cap, adm, ws, regs] = await Promise.all([
      fetchProvider(c),
      fetchCapacity(c),
      fetchAdmission(c),
      fetchWorkspace(c),
      fetchRegistrations(c),
    ])
    provider.value = p
    capacity.value = cap
    admission.value = adm
    workspace.value = ws
    registrations.value = regs.registrations
    status.value = 'ok'
    statusText.value = `${p.name} · ${cap.running} en curso`
  } catch (err) {
    status.value = 'error'
    statusText.value = gatewayErrorMessage(err)
  }
}

function connect(nextUrl: string, nextToken: string): void {
  url.value = setGatewayUrl(nextUrl)
  setToken(nextToken)
  token.value = nextToken.trim()
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
onMounted(() => {
  void refresh()
  // La ocupación cambia sola (otros daemons despachan a este gateway): sin
  // refresco, "0 en curso" quedaría mintiendo hasta que alguien recargue.
  timer = setInterval(() => {
    if (status.value !== 'loading') void refresh()
  }, 5_000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <main class="wrap">
    <GatewayConnectionBar
      :url="url"
      :token="token"
      :status="status"
      :status-text="statusText"
      @connect="connect"
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
