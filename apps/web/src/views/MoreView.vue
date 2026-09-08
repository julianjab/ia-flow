<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { useProjectsStore } from '@/features/projects/store';
import { getSelectedServer } from '@/features/servers/selection';
import { GENERAL_SECTIONS } from '@/router/sections';

/**
 * El índice completo de la app — el cuarto tab.
 *
 * Es el único camino mobile a las 23 pantallas que cubría el drawer: nada se
 * vuelve inalcanzable. Llegar a una sección de configuración pasa de dos
 * toques a tres; a cambio, las tres pantallas de trabajo diario quedan a un
 * toque desde cualquier lugar.
 */
const router = useRouter();
const projectsStore = useProjectsStore();
const activeExecutions = useActiveExecutionsStore();

const projectId = computed(() => projectsStore.activeProjectId);
const projectName = computed(
  () => projectsStore.projects.find((p) => p.id === projectId.value)?.name ?? projectId.value,
);
/** El server que se está mirando, por su puerto — el mismo criterio que ya usa
 *  el chip del header. Con varios runners levantados es la diferencia entre
 *  leer los datos correctos y los de otra máquina. */
const serverLabel = computed(() => {
  const base = getSelectedServer();
  if (!base) return 'proxy';
  try {
    const url = new URL(base);
    return `:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return base;
  }
});

interface Row {
  glyph: string;
  glyphClass?: string;
  label: string;
  to: string;
  /** Contador o estado. No es decoración: es la única señal de que hay algo
   *  que mirar en una pantalla a la que ahora se llega en tres toques. */
  note?: string;
  noteClass?: string;
}

const projectRows = computed<Row[]>(() => {
  const base = `/projects/${projectId.value}`;
  if (!projectId.value) return [];
  // Las ocho tabs del proyecto van UNA POR UNA, no colapsadas en una fila.
  // La sub-nav del proyecto vivía sólo en el sidebar, que bajo 768px ya no se
  // monta: si acá no están, no hay ningún camino. Una fila que promete cinco
  // destinos y navega a uno solo no cumple el "nada se vuelve inalcanzable".
  return [
    { glyph: '●', glyphClass: 'is-accent', label: 'Ejecuciones del proyecto', to: `${base}/executions` },
    { glyph: '⎇', glyphClass: 'is-info', label: 'Repos y ramas', to: `${base}/repos` },
    { glyph: '⛭', glyphClass: 'is-warn', label: 'Pipeline y reglas', to: `${base}/pipeline` },
    { glyph: '✦', glyphClass: 'is-ai', label: 'Agentes', to: `${base}/agentes` },
    { glyph: '▤', label: 'Overview', to: `${base}/overview` },
    { glyph: '➜', label: 'System prompts', to: `${base}/system-prompts` },
    { glyph: '⛭', label: 'Provider', to: `${base}/provider` },
    { glyph: '⛭', label: 'Acciones', to: `${base}/acciones` },
    { glyph: '⛭', label: 'Tools', to: `${base}/tools` },
  ];
});

const serverRows = computed<Row[]>(() => [
  {
    glyph: '▦',
    glyphClass: 'is-accent',
    label: 'Dashboard',
    to: '/dashboard',
  },
  {
    glyph: '●',
    glyphClass: 'is-accent',
    label: 'Todas las ejecuciones',
    to: '/general/ejecuciones',
    // Lo único que el shell ya sabe sin pedir nada: cuántos runs hay vivos.
    ...(activeExecutions.loaded && activeExecutions.activeCount
      ? { note: `${activeExecutions.activeCount} corriendo`, noteClass: 'is-accent' }
      : {}),
  },
  {
    glyph: '▤',
    label: 'Proyectos',
    to: '/projects',
    note: String(projectsStore.projects.length),
  },
  { glyph: '▧', label: 'Logs del daemon', to: '/general/logs' },
  // Estaba fuera del índice, y bajo --bp-shell no hay sidebar: era una
  // pantalla sin ningún camino.
  { glyph: '⊘', label: 'Runs abortados', to: '/general/aborted-runs' },
  // El agent-host NO va acá: habla con otra máquina y con otra credencial, y
  // ofrecerlo dentro de un server es el bug que el menú del shell ya había
  // arreglado (ver AppShell). Se elige en `/servers`, como cualquier otro
  // destino de conexión.
]);

/**
 * La configuración del server, una fila por sección.
 *
 * Era UNA fila —"Configuración general · 11"— que navegaba a `agentes`: la
 * cuenta prometía once destinos y entregaba uno, y como bajo `--bp-shell` no
 * se monta el sidebar, las otras ocho no tenían camino. Mismo criterio que ya
 * seguían las tabs del proyecto acá arriba.
 *
 * La lista es la MISMA que dibuja el sidebar (`router/sections.ts`): tenerla
 * dos veces es lo que dejó que una se quedara vieja.
 */
const configRows = computed<Row[]>(() =>
  GENERAL_SECTIONS.map((sec) => ({ glyph: '⛭', label: sec.label, to: sec.path })),
);

function go(to: string) {
  void router.push(to);
}
</script>

<template>
  <section class="more">
    <header class="more__head">
      <h2>Más</h2>
      <span v-if="serverLabel" class="more__server">{{ serverLabel }}</span>
    </header>

    <template v-if="projectId">
      <span class="uc-label more__group">Proyecto · {{ projectName }}</span>
      <ul class="more__list">
        <li v-for="row in projectRows" :key="row.to">
          <button type="button" class="more__row" @click="go(row.to)">
            <span class="more__glyph" :class="row.glyphClass" aria-hidden="true">{{ row.glyph }}</span>
            <span class="more__label">{{ row.label }}</span>
            <span v-if="row.note" class="more__note" :class="row.noteClass">{{ row.note }}</span>
            <span class="more__chevron" aria-hidden="true">›</span>
          </button>
        </li>
      </ul>
    </template>

    <span class="uc-label more__group">Server</span>
    <ul class="more__list">
      <li v-for="row in serverRows" :key="row.to">
        <button type="button" class="more__row" @click="go(row.to)">
          <span class="more__glyph" :class="row.glyphClass" aria-hidden="true">{{ row.glyph }}</span>
          <span class="more__label">{{ row.label }}</span>
          <span v-if="row.note" class="more__note" :class="row.noteClass">{{ row.note }}</span>
          <span class="more__chevron" aria-hidden="true">›</span>
        </button>
      </li>
    </ul>

    <span class="uc-label more__group">Configuración del server</span>
    <ul class="more__list">
      <li v-for="row in configRows" :key="row.to">
        <button type="button" class="more__row" @click="go(row.to)">
          <span class="more__glyph" aria-hidden="true">{{ row.glyph }}</span>
          <span class="more__label">{{ row.label }}</span>
          <span class="more__chevron" aria-hidden="true">›</span>
        </button>
      </li>
    </ul>

    <ul class="more__list">
      <li>
        <button type="button" class="more__row" @click="go('/servers')">
          <span class="more__glyph" aria-hidden="true">⇄</span>
          <span class="more__label">Cambiar de server</span>
          <span v-if="serverLabel" class="more__note is-info">{{ serverLabel }}</span>
          <span class="more__chevron" aria-hidden="true">›</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.more { display: flex; flex-direction: column; gap: 0.75rem; padding-bottom: 0.5rem; }
.more__head { display: flex; align-items: baseline; gap: 0.5rem; }
.more__head h2 { margin: 0; }
.more__server {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
}
.more__group { display: block; }

.more__list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--border);
}
.more__row {
  width: 100%;
  /* 48px: fila navegable de la capa mobile. */
  height: 48px;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0 1rem;
  background: var(--panel);
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--fg);
  text-align: left;
  cursor: pointer;
}
.more__row:hover { background: var(--panel-hi); }
.more__glyph { flex: 0 0 auto; width: 14px; color: var(--fg-dim); }
.more__glyph.is-info { color: var(--info); }
.more__glyph.is-warn { color: var(--warn); }
.more__glyph.is-ai { color: var(--ai); }
.more__glyph.is-accent { color: var(--accent); }
.more__label {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.more__note {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
}
.more__note.is-accent { color: var(--accent); }
.more__note.is-info { color: var(--info); }
.more__chevron { flex: 0 0 auto; color: var(--fg-dimmer); }
</style>
