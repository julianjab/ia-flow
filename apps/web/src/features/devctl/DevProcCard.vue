<script setup lang="ts">
import type { DevMode, DevProcStatus } from '@/features/devctl/api';
import { fetchLogs } from '@/features/devctl/api';
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  status: DevProcStatus;
  /** El start/stop de ESTE proceso está en vuelo — deshabilita sus controles. */
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'start', payload: { id: string; mode: DevMode; port: number }): void;
  (e: 'stop', id: string): void;
}>();

const running = computed(() => props.status.managed);
/** Editable sólo cuando no hay nada corriendo en ese puerto — ni nuestro ni ajeno. */
const canConfigure = computed(() => !props.status.managed && !props.status.portOpen);

const modeDraft = ref<DevMode>(props.status.mode ?? 'dev');
const portDraft = ref<number>(props.status.port ?? props.status.defaultPort);

// Cuando deja de correr, el draft vuelve a reflejar lo real (o el default) —
// así un proceso que se cayó no deja el formulario con el puerto de la
// corrida anterior si ese puerto ya lo tomó otra cosa.
watch(
  () => [props.status.managed, props.status.port, props.status.mode] as const,
  ([managed, port, mode]) => {
    if (!managed) {
      portDraft.value = port ?? props.status.defaultPort;
      if (mode) modeDraft.value = mode;
    }
  },
);

const displayPort = computed(() => props.status.port ?? props.status.defaultPort);

type DotKind = 'live' | 'external' | 'crashed' | 'off';
const dotKind = computed<DotKind>(() => {
  if (props.status.managed) return 'live';
  if (props.status.portOpen) return 'external';
  if (props.status.lastExit && props.status.lastExit.code !== 0) return 'crashed';
  return 'off';
});

const exitText = computed(() => {
  const exit = props.status.lastExit;
  if (!exit || props.status.managed) return '';
  if (exit.signal) return `se detuvo (${exit.signal})`;
  if (exit.code === 0) return 'terminó (code 0)';
  return `falló (code ${exit.code ?? '?'})`;
});

const stateText = computed(() => {
  if (props.status.managed) return `${props.status.mode} · :${displayPort.value}`;
  if (props.status.portOpen) return `externo · :${displayPort.value}`;
  if (exitText.value) return exitText.value;
  return 'detenido';
});

function onStart() {
  emit('start', { id: props.status.id, mode: modeDraft.value, port: portDraft.value });
}

const logsOpen = ref(false);
const logsText = ref('');
const logsLoading = ref(false);

async function toggleLogs() {
  logsOpen.value = !logsOpen.value;
  if (logsOpen.value) await refreshLogs();
}

async function refreshLogs() {
  logsLoading.value = true;
  try {
    const lines = await fetchLogs(props.status.id);
    logsText.value = lines.length ? lines.join('\n') : '(sin salida todavía)';
  } finally {
    logsLoading.value = false;
  }
}
</script>

<template>
  <article class="dp-card" :class="{ 'dp-card--live': dotKind === 'live' }">
    <header class="dp-card__hd">
      <span class="dp-dot" :class="`dp-dot--${dotKind}`" />
      <span class="dp-card__label">{{ status.label }}</span>
      <span class="dp-card__state uc-label">{{ stateText }}</span>
    </header>

    <div class="dp-card__row">
      <span class="uc-label" :id="`dp-port-${status.id}`">puerto</span>
      <input
        v-if="canConfigure"
        v-model.number="portDraft"
        type="number"
        min="1"
        max="65535"
        class="ff-field dp-card__input"
        :aria-labelledby="`dp-port-${status.id}`"
      />
      <span v-else class="mono dp-card__val">{{ displayPort }}</span>
    </div>

    <div class="dp-card__row">
      <span class="uc-label" :id="`dp-mode-${status.id}`">modo</span>
      <select
        v-if="canConfigure"
        v-model="modeDraft"
        class="ff-field dp-card__select"
        :aria-labelledby="`dp-mode-${status.id}`"
      >
        <option value="dev">dev</option>
        <option value="run">run</option>
      </select>
      <span v-else class="mono dp-card__val">{{ status.mode ?? modeDraft }}</span>
    </div>

    <p v-if="status.pid" class="dp-card__meta mono">pid {{ status.pid }}</p>

    <div class="dp-card__actions">
      <button
        v-if="canConfigure"
        class="btn"
        type="button"
        :disabled="busy"
        @click="onStart"
      >
        {{ busy ? 'levantando…' : 'levantar' }}
      </button>
      <button
        v-else-if="status.managed"
        class="btn"
        type="button"
        :disabled="busy"
        @click="emit('stop', status.id)"
      >
        {{ busy ? 'deteniendo…' : 'detener' }}
      </button>
      <span v-else class="dp-card__external uc-label">corriendo (externo)</span>

      <button class="btn btn--ghost dp-card__logsbtn" type="button" @click="toggleLogs">
        {{ logsOpen ? 'ocultar logs' : 'ver logs' }}
      </button>
    </div>

    <div v-if="logsOpen" class="dp-card__logsbox">
      <button class="btn btn--ghost dp-card__refresh" type="button" :disabled="logsLoading" @click="refreshLogs">
        {{ logsLoading ? 'actualizando…' : 'actualizar' }}
      </button>
      <pre class="dp-card__logs mono">{{ logsText }}</pre>
    </div>
  </article>
</template>

<style scoped src="@/ui/form-fields.css" />
<style scoped>
.dp-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
}
.dp-card--live {
  border-color: var(--accent);
}

.dp-card__hd {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.dp-card__label {
  font-weight: 600;
}
.dp-card__state {
  margin-left: auto;
}

.dp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.dp-dot--live {
  background: var(--accent);
  animation: dp-blink 1.6s ease-in-out infinite;
}
.dp-dot--external {
  background: var(--warn);
}
.dp-dot--crashed {
  background: var(--danger);
}
.dp-dot--off {
  background: var(--fg-dim);
}
@keyframes dp-blink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0.35;
  }
}

.dp-card__row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.dp-card__row .uc-label {
  flex: 0 0 4rem;
}
.dp-card__input,
.dp-card__select {
  flex: 1;
  min-width: 0;
}
.dp-card__val {
  color: var(--fg-mute);
}

.dp-card__meta {
  margin: 0;
  color: var(--fg-dim);
  font-size: var(--fs-micro);
}

.dp-card__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.15rem;
}
.dp-card__external {
  color: var(--warn);
}
.dp-card__logsbtn {
  margin-left: auto;
  padding: 0 0.5rem;
}

.dp-card__logsbox {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.dp-card__refresh {
  align-self: flex-start;
  padding: 0 0.5rem;
}
.dp-card__logs {
  margin: 0;
  max-height: 12rem;
  overflow: auto;
  padding: 0.5rem;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: var(--fs-micro);
  white-space: pre-wrap;
  word-break: break-all;
}

@media (max-width: 640px) {
  .dp-card__row {
    flex-wrap: wrap;
  }
}
</style>
