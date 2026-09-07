<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useServerEvents } from '@/composables/useServerEvents';
import { fetchPollingStatus, pausePolling, resumePolling } from '@/features/projects/api';
import { useToastStore } from '@/stores/toast';

/**
 * Pausar el polling de un proyecto.
 *
 * Vivía suelto en el encabezado del detalle de proyecto — el `.pd-header` que
 * repetía el nombre que la barra de identidad ya dice (R9, R12). Al borrar ese
 * encabezado el control necesitaba una casa propia, y traer con él su estado:
 * el flag lo persiste el backend en `projects.settings.pollingPaused`, hay un
 * broadcast por WS para que dos pestañas no se contradigan, y nada de eso
 * pertenecía a una vista que sólo compone tabs.
 *
 * Es autónomo a propósito: se monta donde haga falta (hoy, el sheet de `⋯`)
 * sin que su contenedor tenga que saber de polling.
 */
const props = defineProps<{ projectId: string }>();

const toastStore = useToastStore();

const paused = ref(false);
/** false sólo cuando el server avisa que no pudo persistir el flip. */
const persisted = ref(true);
const loading = ref(false);
const toggling = ref(false);

async function load() {
  loading.value = true;
  try {
    const s = await fetchPollingStatus(props.projectId);
    paused.value = s.paused;
  } catch {
    // 404s mientras la lista de proyectos calienta son normales — paused=false.
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => props.projectId, load);

// El server hace broadcast de cualquier pausa/reanudación para que una segunda
// pestaña no muestre lo contrario de lo que pasa.
useServerEvents((msg) => {
  if (msg.type !== 'project:polling') return;
  if (msg.projectId !== props.projectId) return;
  paused.value = Boolean(msg.paused);
  persisted.value = msg.persisted !== false;
});

async function toggle() {
  if (toggling.value) return;
  toggling.value = true;
  const target = !paused.value;
  try {
    const s = target ? await pausePolling(props.projectId) : await resumePolling(props.projectId);
    paused.value = s.paused;
    persisted.value = s.persisted !== false;
    const what = s.paused ? 'Polling pausado' : 'Polling reanudado';
    if (persisted.value) toastStore.success(what);
    else toastStore.error(`${what}, pero no se pudo guardar: se pierde al reiniciar el daemon`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    toggling.value = false;
  }
}
</script>

<template>
  <button
    type="button"
    class="ppt"
    :class="{ 'ppt--paused': paused }"
    :disabled="loading || toggling"
    :title="paused
      ? 'Polling en pausa — click para reanudar'
      : persisted
        ? 'Polling activo — click para pausar (se mantiene al reiniciar el daemon)'
        : 'Polling activo — click para pausar (no se pudo guardar: se pierde al reiniciar)'"
    data-testid="project-polling-toggle"
    role="switch"
    :aria-checked="!paused"
    @click="toggle"
  >
    <span class="ppt__dot" :class="{ 'ppt__dot--paused': paused }" />
    <span class="ppt__label">
      <template v-if="loading">…</template>
      <template v-else-if="toggling">{{ paused ? 'Reanudando…' : 'Pausando…' }}</template>
      <template v-else>{{ paused ? 'Polling pausado' : 'Polling activo' }}</template>
    </span>
  </button>
</template>

<style scoped>
.ppt {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  /* Se toca: --tap-h (R1). Antes eran 22px. */
  height: var(--tap-h);
  padding: 0 1rem;
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  text-align: left;
}
.ppt:hover:not(:disabled) { background: var(--panel-hi); }
.ppt:disabled { opacity: 0.6; cursor: not-allowed; }
.ppt--paused { color: var(--danger); }

.ppt__dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  background: var(--accent);
  animation: blink 1.6s ease-in-out infinite;
}
.ppt__dot--paused { background: var(--danger); animation: none; }
</style>
