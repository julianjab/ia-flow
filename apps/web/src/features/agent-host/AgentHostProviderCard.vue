<script setup lang="ts">
// Qué provider concreto ejecuta este agent-host, y cuánto está corriendo ahora.
// Cambiarlo re-registra el agent-host contra sus servers: sin eso, el server
// seguiría anunciando el provider viejo (guardó nombre y descripción al
// registrarse).

import type { AgentHostCapacity, AgentHostProvider } from './api'

defineProps<{
  provider: AgentHostProvider | null
  capacity: AgentHostCapacity | null
  saving: boolean
}>()
defineEmits<{ select: [id: string] }>()
</script>

<template>
  <section class="settings-section">
    <div class="section-header">
      <div class="section-head-text">
        <h2>provider</h2>
        <p class="section-desc">Qué ejecuta esta máquina. El server no lo elige: lo elige el agent-host.</p>
      </div>
    </div>
    <div class="body">
      <template v-if="provider">
        <div class="ff-row">
          <span class="uc-label">provider</span>
          <select
            class="ff-field"
            :value="provider.id"
            :disabled="saving"
            @change="$emit('select', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="id in provider.available" :key="id" :value="id">{{ id }}</option>
          </select>
        </div>
        <p class="meta">
          <span class="uc-label">tipo</span> {{ provider.kind }} · {{ provider.name }}
        </p>
      </template>

      <p v-if="capacity" class="meta">
        <span class="uc-label">en curso</span> {{ capacity.running
        }}<template v-if="capacity.maxConcurrentRuns"> / {{ capacity.maxConcurrentRuns }}</template>
        <template v-if="!capacity.accepting">
          — <span class="meta__no">no acepta: {{ capacity.reason }}</span>
        </template>
      </p>
    </div>
  </section>
</template>

<style scoped src="@/ui/form-fields.css" />
<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.meta {
  margin: 0;
  color: var(--fg-mute);
  font-size: var(--fs-body-sm);
}
.meta__no {
  color: var(--warn);
}
</style>
