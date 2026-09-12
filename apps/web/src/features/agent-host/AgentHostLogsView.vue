<script setup lang="ts">
// Los logs del agent-host elegido, a pantalla completa.
//
// Antes tenía su propia tarjeta (AgentHostLogsCard, borrada) con un
// filtro de texto simple — mucho más chica que la vista de logs del server
// (columnas configurables, árbol JSON, resumen por nivel). Ahora monta la
// MISMA vista (`components/LogStreamSection.vue`, generalizada para eso):
// el agent-host es sólo otro backend con otro adapter (`fetchAgentHostLogs`),
// sin Live (no expone `/ws`), sin filtros de servidor más allá de
// nivel/texto libre, y con un `pollMs` que reemplaza al Live que no tiene.
import LogStreamSection from '@/components/LogStreamSection.vue'
import { fetchAgentHostLogs } from './api'
import { isAgentHostSelected, selectedAgentHostClient } from './connection'

const selected = isAgentHostSelected()

// Se resuelve por llamada, no una vez: el cliente depende del server elegido
// en ese momento (ver connection.ts).
function fetchLogs(filters: Parameters<typeof fetchAgentHostLogs>[1]) {
  return fetchAgentHostLogs(selectedAgentHostClient(), filters)
}
</script>

<template>
  <main class="wrap">
    <p v-if="!selected" class="hint">
      · lo que estás mirando no es un agent-host —
      <RouterLink to="/servers">elegí uno en la lista de servers</RouterLink>
    </p>

    <LogStreamSection
      v-else
      title="Logs del agent-host"
      :fetch-logs="fetchLogs"
      :live="false"
      :field-filters="false"
      :sortable="false"
      :poll-ms="5000"
    >
      <template #description>
        <p class="section-desc">
          Boot, registración, sondas de capacidad y líneas de cada run — mismo formato NDJSON
          que <code>daemon.log</code>, sin Live (este proceso no expone <code>/ws</code>): se
          refresca solo cada 5s.
        </p>
      </template>
    </LogStreamSection>
  </main>
</template>

<style scoped>
.wrap {
  padding: 1.5rem;
}
.hint { color: var(--fg-dim); font-size: var(--fs-body-sm); }
</style>
