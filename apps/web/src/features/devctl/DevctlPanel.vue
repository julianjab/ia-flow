<script setup lang="ts">
import type { DevMode, DevProcStatus } from '@/features/devctl/api';
import { fetchStatus, isDevctlAvailable, startProcess, stopProcess } from '@/features/devctl/api';
import DevProcCard from '@/features/devctl/DevProcCard.vue';
import { useToastStore } from '@/stores/toast';
import { onMounted, onUnmounted, ref } from 'vue';

const POLL_MS = 2000;

const available = isDevctlAvailable();
const toast = useToastStore();

const statuses = ref<DevProcStatus[]>([]);
/** Sólo para el spinner de la primera carga — el poll de después no parpadea. */
const loading = ref(true);
/** ids con un start/stop en vuelo, para deshabilitar sus propios controles. */
const busyIds = ref<Set<string>>(new Set());

let timer: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  statuses.value = await fetchStatus();
  loading.value = false;
}

async function handleStart(payload: { id: string; mode: DevMode; port: number }) {
  busyIds.value = new Set(busyIds.value).add(payload.id);
  try {
    const result = await startProcess(payload.id, payload.mode, payload.port);
    if (!result.ok) toast.error(result.error);
    await refresh();
  } finally {
    const next = new Set(busyIds.value);
    next.delete(payload.id);
    busyIds.value = next;
  }
}

async function handleStop(id: string) {
  busyIds.value = new Set(busyIds.value).add(id);
  try {
    const result = await stopProcess(id);
    if (!result.ok) toast.error(result.error);
    await refresh();
  } finally {
    const next = new Set(busyIds.value);
    next.delete(id);
    busyIds.value = next;
  }
}

onMounted(() => {
  if (!available) return;
  void refresh();
  timer = setInterval(() => void refresh(), POLL_MS);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="dp-panel">
    <p v-if="!available" class="dp-panel__empty">
      · este panel sólo funciona dentro de la app de escritorio de ia-flow — desde acá no hay
      forma de levantar procesos en tu máquina.
    </p>
    <p v-else-if="loading" class="dp-panel__empty">· cargando…</p>
    <div v-else class="dp-panel__grid">
      <DevProcCard
        v-for="s in statuses"
        :key="s.id"
        :status="s"
        :busy="busyIds.has(s.id)"
        @start="handleStart"
        @stop="handleStop"
      />
    </div>
  </div>
</template>

<style scoped>
.dp-panel__empty {
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
}
.dp-panel__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 0.8rem;
}
</style>
