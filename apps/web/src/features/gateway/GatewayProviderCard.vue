<script setup lang="ts">
// Qué provider concreto ejecuta este gateway, y cuánto está corriendo ahora.
// Cambiarlo re-registra el gateway contra sus servers: sin eso, el server
// seguiría anunciando el provider viejo (guardó nombre y descripción al
// registrarse).

import type { GatewayCapacity, GatewayProvider } from './api'

defineProps<{
  provider: GatewayProvider | null
  capacity: GatewayCapacity | null
  saving: boolean
}>()
defineEmits<{ select: [id: string] }>()
</script>

<template>
  <section class="panel">
    <header class="panel__header">provider</header>
    <div class="body">
      <p class="hint">Qué ejecuta esta máquina. El server no lo elige: lo elige el gateway.</p>

      <template v-if="provider">
        <label class="field">
          <span class="uc-label">provider</span>
          <select
            class="field__input"
            :value="provider.id"
            :disabled="saving"
            @change="$emit('select', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="id in provider.available" :key="id" :value="id">{{ id }}</option>
          </select>
        </label>
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

<style scoped>
.body {
  padding: 0.75rem;
}
.hint {
  margin: 0 0 0.75rem;
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
}
.field {
  display: block;
  margin-bottom: 0.5rem;
}
.field__input {
  width: 100%;
  margin-top: 0.25rem;
  height: calc(var(--row-h) + 0.5rem);
  padding: 0 0.5rem;
  background: var(--panel-hi);
  border: 1px solid var(--border);
  color: var(--fg);
  font-size: var(--fs-body-sm);
}
.meta {
  margin: 0.25rem 0 0;
  color: var(--fg-mute);
  font-size: var(--fs-body-sm);
}
.meta__no {
  color: var(--yellow);
}
</style>
