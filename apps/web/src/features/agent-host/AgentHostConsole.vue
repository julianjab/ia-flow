<script setup lang="ts">
// La consola de UN agent-host: el que está elegido en el picker de servers.
//
// Reemplaza la página vanilla que cada agent-host servía (apps/agent-host/src/ui.ts,
// borrada): al vivir acá reusa los componentes y el tema de la web.
//
// Ya no trae su propio selector de máquina. Cambiar de agent-host es lo mismo
// que cambiar de server —se hace en `/servers`—, y tener dos formas de elegir
// a quién le hablás significaba que la barra de arriba y el picker podían
// discrepar sobre cuál estabas mirando.

import { computed, onMounted, onUnmounted, ref } from 'vue'
import AgentHostAdmissionCard from './AgentHostAdmissionCard.vue'
import AgentHostProviderCard from './AgentHostProviderCard.vue'
import AgentHostServersCard from './AgentHostServersCard.vue'
import AgentHostWorkspaceCard from './AgentHostWorkspaceCard.vue'
import {
  type AgentHostAdmission,
  type AgentHostCapacity,
  type AgentHostProvider,
  type AgentHostRegistration,
  type AgentHostWorkspace,
  addRegistration,
  agentHostErrorMessage,
  fetchAdmission,
  fetchCapacity,
  fetchProvider,
  fetchRegistrations,
  fetchWorkspace,
  removeRegistration,
  saveAdmission,
  saveWorkspace,
  setProvider,
} from './api'
import { isAgentHostSelected, selectedAgentHostClient, selectedAgentHostUrl } from './connection'

const selected = isAgentHostSelected()
const url = selectedAgentHostUrl()

const status = ref<'ok' | 'error' | 'loading'>('loading')
const statusText = ref('conectando…')
const saving = ref<string | null>(null)

const provider = ref<AgentHostProvider | null>(null)
const capacity = ref<AgentHostCapacity | null>(null)
const admission = ref<AgentHostAdmission | null>(null)
const workspace = ref<AgentHostWorkspace | null>(null)
const registrations = ref<AgentHostRegistration[]>([])

const client = computed(() => selectedAgentHostClient())

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
    statusText.value = agentHostErrorMessage(err)
  }
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
onMounted(() => {
  if (!selected) return
  void refresh()
  // La ocupación cambia sola (otros daemons despachan a este agent-host): sin
  // refresco, "0 en curso" quedaría mintiendo hasta que alguien recargue.
  timer = setInterval(() => {
    if (status.value !== 'loading') void refresh()
  }, 5_000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <main class="wrap">
    <!-- Entrar acá estando en un server no es un error del agent-host: es un
         deep-link viejo o un bookmark. Se dice dónde está el cambio en vez de
         mostrar cinco tarjetas vacías. -->
    <p v-if="!selected" class="hint">
      · lo que estás mirando no es un agent-host —
      <RouterLink to="/servers">elegí uno en la lista de servers</RouterLink>
    </p>

    <template v-else>
      <header class="hd">
        <span class="dot" :class="`dot--${status}`" />
        <span class="hd__url">{{ url }}</span>
        <span class="hd__status">{{ statusText }}</span>
      </header>

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
      </div>
    </template>
  </main>
</template>

<style scoped>
.wrap {
  max-width: 60rem;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
.hd {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  font-size: 0.85rem;
}
.hd__url { font-weight: 600; }
.hd__status { color: var(--fg-dim); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dot--ok { background: var(--accent); }
.dot--error { background: var(--danger); }
.dot--loading { background: var(--fg-dim); }
.hint { color: var(--fg-dim); }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr));
  gap: 1rem;
  align-items: start;
}
</style>
