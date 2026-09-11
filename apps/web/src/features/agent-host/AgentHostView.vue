<script setup lang="ts">
// Las cuatro pantallas de configuración de UN agent-host: el elegido en el
// picker de servers (`/agent-host/:tab`).
//
// Reemplaza a `AgentHostConsole.vue` (borrado), que las apeñuscaba a las
// cuatro en una sola grilla de tarjetas. Separadas en tabs de sidebar —mismo
// patrón que `/general/:tab` para el server (`GeneralView.vue`)— cada una es
// su propia pantalla y deja de competir por ancho con las otras tres.

import { computed, onMounted, onUnmounted } from 'vue'
import { AGENT_HOST_SECTIONS, type AgentHostTabId } from '@/router/sections'
import AgentHostAdmissionCard from './AgentHostAdmissionCard.vue'
import AgentHostProviderCard from './AgentHostProviderCard.vue'
import AgentHostServersCard from './AgentHostServersCard.vue'
import AgentHostSystemPromptCard from './AgentHostSystemPromptCard.vue'
import AgentHostWorkspaceCard from './AgentHostWorkspaceCard.vue'
import { isAgentHostSelected, selectedAgentHostUrl } from './connection'
import { useAgentHostStore } from './store'

const props = defineProps<{ tab: string }>()

const selected = isAgentHostSelected()
const url = selectedAgentHostUrl()
const store = useAgentHostStore()

const activeTab = computed<AgentHostTabId>(() =>
  AGENT_HOST_SECTIONS.some((s) => s.id === props.tab) ? (props.tab as AgentHostTabId) : 'provider',
)

// El componente monta UNA vez y sobrevive a cambiar de tab (mismo componente
// de ruta, cambia el param) — por eso el poll arranca acá y no en cada card.
onMounted(() => {
  if (selected) store.start()
})
onUnmounted(() => {
  if (selected) store.stop()
})
</script>

<template>
  <main class="wrap">
    <!-- Entrar acá estando en un server no es un error del agent-host: es un
         deep-link viejo o un bookmark. Se dice dónde está el cambio en vez de
         mostrar una pantalla vacía. -->
    <p v-if="!selected" class="hint">
      · lo que estás mirando no es un agent-host —
      <RouterLink to="/servers">elegí uno en la lista de servers</RouterLink>
    </p>

    <template v-else>
      <header class="hd">
        <span class="dot" :class="`dot--${store.status}`" />
        <span class="hd__url">{{ url }}</span>
        <span class="hd__status">{{ store.statusText }}</span>
      </header>

      <AgentHostProviderCard
        v-if="activeTab === 'provider'"
        :provider="store.provider"
        :capacity="store.capacity"
        :saving="store.saving === 'provider'"
        @select="store.setProvider"
      />
      <AgentHostWorkspaceCard
        v-else-if="activeTab === 'workspace'"
        :model-value="store.workspace"
        :saving="store.saving === 'workspace'"
        @save="store.saveWorkspace"
      />
      <AgentHostAdmissionCard
        v-else-if="activeTab === 'admission'"
        :model-value="store.admission"
        :saving="store.saving === 'admission'"
        @save="store.saveAdmission"
      />
      <AgentHostSystemPromptCard
        v-else-if="activeTab === 'system-prompt'"
        :model-value="store.systemPrompt"
        :saving="store.saving === 'systemPrompt'"
        @save="store.saveSystemPrompt"
      />
      <AgentHostServersCard
        v-else-if="activeTab === 'servers'"
        :registrations="store.registrations"
        :saving="store.saving === 'servers'"
        @add="store.addRegistration"
        @remove="store.removeRegistration"
      />
    </template>
  </main>
</template>

<style scoped>
.wrap {
  max-width: 46rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.hd {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--fs-body-sm);
}
.hd__url { font-weight: 600; }
.hd__status { color: var(--fg-dim); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dot--ok { background: var(--accent); }
.dot--error { background: var(--danger); }
.dot--loading { background: var(--fg-dim); }
.hint { color: var(--fg-dim); }
</style>
