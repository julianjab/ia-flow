<script setup lang="ts">
// Los runs en vuelo en ESTE agent-host — lo que faltaba para saber, sin mirar
// el daemon, si esta máquina está haciendo algo ahora mismo. Mismo patrón
// visual que AgentHostLogsCard: una tabla angosta, cero configuración propia.

import type { AgentHostRun } from './api'

defineProps<{ running: number | null; runs: AgentHostRun[] | null }>()

const monthAbbr = new Intl.DateTimeFormat('es', { month: 'short' })

/** Igual que en AgentHostLogsCard: hora local, y fecha sólo si no es hoy. */
function clock(time: string): string {
  const d = new Date(time)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay ? hms : `${pad(d.getDate())} ${monthAbbr.format(d)} ${hms}`
}
</script>

<template>
  <section class="panel runs">
    <header class="panel__header">
      runs
      <span v-if="running != null" class="hd__count">{{ running }} en curso</span>
    </header>
    <div class="body">
      <p v-if="!runs" class="hint">· cargando</p>
      <template v-else>
        <ol class="lines">
          <li v-for="(run, i) in runs" :key="run.runId ?? i" class="line">
            <span class="line__time">{{ clock(run.startedAt) }}</span>
            <span class="line__mode" :class="`line__mode--${run.mode}`">{{ run.mode }}</span>
            <span class="line__task">{{ run.taskId }}</span>
            <span class="line__agent">{{ run.agentId ?? '—' }}</span>
            <span class="line__project">{{ run.projectId ?? '—' }}</span>
          </li>
          <li v-if="!runs.length" class="hint">· sin runs en vuelo</li>
        </ol>
      </template>
    </div>
  </section>
</template>

<style scoped>
.runs {
  grid-column: 1 / -1;
}
.panel__header {
  justify-content: space-between;
}
.hd__count {
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
  text-transform: none;
  letter-spacing: normal;
}
.body {
  padding: 0.5rem 0.75rem;
}
.hint {
  margin: 0;
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
}
.lines {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 22rem;
  overflow-y: auto;
}
.line {
  display: flex;
  gap: 0.75ch;
  height: var(--row-h);
  align-items: center;
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  white-space: nowrap;
}
.line:hover {
  background: var(--panel-hi);
}
.line__time {
  color: var(--fg-dimmer);
  flex: none;
}
.line__mode {
  flex: none;
  width: 8ch;
  color: var(--fg-dim);
}
.line__mode--detached {
  color: var(--info);
}
.line__task {
  flex: none;
  color: var(--fg);
}
.line__agent,
.line__project {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg-mute);
}
</style>
