<script setup lang="ts">
// El final del log del agent-host. La tenía la pantalla vieja y se perdió al
// mover la consola acá — es la única ventana a lo que pasa en esa máquina
// cuando se abre desde el Finder y su stdout no lo ve nadie.
//
// El filtro se manda al server (`?q=`) en vez de aplicarse sobre lo ya
// traído: filtrar la última página encontraría los errores salvo justo los
// que uno busca, que son los viejos.

import { ref } from 'vue'
import type { AgentHostLogLine, AgentHostLogTail } from './api'

defineProps<{ tail: AgentHostLogTail | null }>()
const emit = defineEmits<{ query: [q: string] }>()

const q = ref('')
const expanded = ref<number | null>(null)

const LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

function levelName(line: AgentHostLogLine): string {
  return line.level ? (LEVELS[line.level] ?? '') : ''
}

/** Sólo la hora: la fecha es hoy en el 99% de los casos y ocupa media fila. */
function clock(time?: string): string {
  if (!time) return ''
  const d = new Date(time)
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
}
</script>

<template>
  <section class="panel logs">
    <header class="panel__header">
      logs
      <input
        v-model="q"
        class="logs__filter"
        placeholder="filtrar…"
        spellcheck="false"
        @keyup.enter="emit('query', q)"
      />
    </header>
    <div class="body">
      <p v-if="!tail" class="hint">· cargando</p>
      <p v-else-if="!tail.file" class="hint">
        · este agent-host corre sin archivo de log (su stdout va a quien lo levantó)
      </p>
      <template v-else>
        <p v-if="tail.truncated" class="hint">
          · hay historia más vieja que la ventana de búsqueda
        </p>
        <ol class="lines">
          <li
            v-for="(line, i) in tail.lines"
            :key="i"
            class="line"
            :class="`line--${levelName(line)}`"
            @click="expanded = expanded === i ? null : i"
          >
            <span class="line__time">{{ clock(line.time) }}</span>
            <span class="line__lvl">{{ levelName(line) }}</span>
            <span class="line__scope">{{ line.scope }}</span>
            <span class="line__msg">{{ line.msg ?? line.raw }}</span>
          </li>
          <li v-if="!tail.lines.length" class="hint">· sin líneas</li>
        </ol>
        <pre v-if="expanded !== null && tail.lines[expanded]" class="detail">{{
          JSON.stringify(tail.lines[expanded]?.extras ?? {}, null, 2)
        }}</pre>
      </template>
    </div>
  </section>
</template>

<style scoped>
.logs {
  grid-column: 1 / -1;
}
.panel__header {
  justify-content: space-between;
}
.logs__filter {
  height: var(--row-h);
  padding: 0 0.5ch;
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--font-mono);
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
  cursor: pointer;
}
.line:hover {
  background: var(--panel-hi);
}
.line__time {
  color: var(--fg-dimmer);
  flex: none;
}
.line__lvl {
  flex: none;
  width: 5ch;
  color: var(--fg-dim);
}
.line--warn .line__lvl {
  color: var(--warn);
}
.line--error .line__lvl,
.line--fatal .line__lvl {
  color: var(--danger);
}
.line__scope {
  flex: none;
  color: var(--ai);
}
.line__msg {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg-mute);
}
.detail {
  margin: 0.5rem 0 0;
  padding: 0.5rem;
  background: var(--panel-hi);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  color: var(--fg-mute);
  max-height: 14rem;
  overflow: auto;
}
</style>
