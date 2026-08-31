<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SettingsSidebar from '@/components/SettingsSidebar.vue';
import ActiveExecutionsChip from '@/components/ActiveExecutionsChip.vue';
import RateLimitChip from '@/components/RateLimitChip.vue';
import Toast from '@/ui/Toast.vue';
import { useProvidersStore } from '@/features/providers/store';
import { useProjectsStore } from '@/features/projects/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useGlobalConfigStore } from '@/features/project-config/globalStore';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { useRateLimitStore } from '@/features/github/store';
import { useServerEvents } from '@/composables/useServerEvents';
import { getSelectedKind, getSelectedServer } from '@/features/servers/selection';
import { useToastStore } from '@/stores/toast';
import { fetchProjectStatuses } from '@/features/projects/sourceApi';

const providersStore = useProvidersStore();
const projectsStore = useProjectsStore();
const projectConfigStore = useProjectConfigStore();
const globalConfigStore = useGlobalConfigStore();
const activeExecutionsStore = useActiveExecutionsStore();
const rateLimitStore = useRateLimitStore();
const toastStore = useToastStore();

/**
 * ¿Lo que estamos mirando es un agent-host y no un server?
 *
 * Es una const y no un computed a propósito: cambiar de proceso pasa por
 * `window.location.assign` (ver `enter()` en ServerPickerView), o sea una
 * recarga completa. Nada puede cambiar este valor mientras el shell vive.
 *
 * Parte casi todo lo de abajo, y no por estética: un agent-host **no tiene**
 * `/api/projects`, ni `/api/providers`, ni el WebSocket de eventos. Dibujarle
 * el menú del server no le daría pantallas de más — le daría catorce entradas
 * que sólo pueden devolver 404, y el shell arrancaría escupiendo cuatro toasts
 * de error antes de que el operador toque nada.
 */
const isAgentHost = getSelectedKind() === 'agent-host';

// Sidebar arquitectura de información:
//   OVERVIEW    → dashboard, ejecuciones, logs
//   PROYECTOS   → un item por proyecto (expandible con sus tabs)
//   GLOBAL      → configuración que aplica a todos los proyectos (definida a
//                 nivel top; el equivalente por-proyecto vive en las tabs del
//                 propio proyecto).
// "general" ya no existe como wrapper — sus secciones son ahora nav de
// primer nivel. Las rutas /general/<x> se mantienen para no romper deep-links
// existentes.
type SectionId =
  | 'servers'
  | 'dashboard'
  | 'ejecuciones'
  | 'logs'
  | 'agent-host'
  | 'agent-host-logs'
  | 'proyectos'
  | 'agentes'
  | 'system-prompts'
  | 'providers'
  | 'mcp-catalog'
  | 'entorno'
  | 'escaneo';

// Tabs internos de cada proyecto — se muestran indentados bajo el proyecto
// activo en el árbol. Mismo orden que ProjectDetailView.
const PROJECT_TAB_ORDER: { id: string; label: string }[] = [
  { id: 'overview',       label: 'overview' },
  { id: 'executions',     label: 'ejecuciones' },
  { id: 'tareas',         label: 'tareas' },
  { id: 'board',          label: 'board' },
  { id: 'agentes',        label: 'agentes' },
  { id: 'system-prompts', label: 'system prompts' },
  { id: 'repos',          label: 'repos' },
  { id: 'provider',       label: 'provider' },
];

// El tab "board" (StatusesSection) muestra los statuses que devuelve el
// source del proyecto — para varios proyectos github-issues eso viene 100%
// de labels `status:*` reales en el repo, y si nunca se usaron (pipelines
// puramente label/when-driven, como runners/subscriptions-pipeline) queda
// vacío y sin sentido. En vez de una regla estática por `source.kind` (los
// 3 kinds registrados SÍ implementan getStatuses()), se resuelve en runtime:
// ocultar "board" solo cuando ese fetch efectivamente devuelve 0 statuses.
//
// Solo se resuelve para `activeProjectId` — el árbol del sidebar solo
// renderiza los tabs del proyecto activo (ver SettingsSidebar `v-if
// isChildActive`), así que pedirlo para cada proyecto del store en cada
// mount del shell sería un fan-out de N llamadas al source (rate limit de
// GitHub) para decidir el estado de un ítem que ni se ve. Como efecto
// secundario, esto también evita el cacheo permanente: al entrar de nuevo a
// un proyecto se vuelve a resolver, así que un status agregado por fuera de
// la app (label puesta a mano en GitHub) se refleja en la próxima visita —
// no instantáneo, pero no queda pegado para siempre como con un Map global.
const activeProjectHasStatuses = ref(true);

// Etiqueta corta del server que se está mirando — el puerto alcanza para
// distinguir el server local del container de un runner.
const viewingServerLabel = computed(() => {
  const base = getSelectedServer();
  if (!base) return 'proxy';
  const url = new URL(base);
  return `:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
});

function goToServers() {
  router.push('/servers');
}

watch(
  () => projectsStore.activeProjectId,
  async (id) => {
    // Mostrar mientras se resuelve — si no, cambiar de un proyecto sin
    // statuses a uno con statuses ocultaría "board" durante todo el fetch,
    // exactamente el parpadeo que este diseño evita para el estado inicial.
    activeProjectHasStatuses.value = true;
    if (isAgentHost || !id) return;
    try {
      const res = await fetchProjectStatuses(id);
      // Dos cambios de proyecto seguidos disparan dos fetches sin
      // cancelación — si este resuelve después de que el usuario ya
      // navegó a otro proyecto, descartarlo en vez de pisar el estado del
      // proyecto actual con el de uno viejo.
      if (projectsStore.activeProjectId !== id) return;
      activeProjectHasStatuses.value = res.statuses.length > 0;
    } catch {
      if (projectsStore.activeProjectId !== id) return;
      // Falla de red/source caído: no ocultar el tab por una falla transitoria.
      activeProjectHasStatuses.value = true;
    }
  },
  { immediate: true },
);

const TAB_GROUP_LABELS: Record<string, string> = {
  overview: 'OVERVIEW',
  proyectos: 'PROYECTOS',
  global: 'GLOBAL',
};

// Desktop: sidebar expanded by default (no hamburger-only rail).
// Mobile: collapsed by default (overlay, opened via topbar toggle).
const isMobile = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
const sidebarCollapsed = ref(isMobile());
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; }

const route = useRoute();
const router = useRouter();

// Cada sección de primer nivel apunta a una ruta fija. Se usa para: navegar
// al hacer clic en el padre + resaltar la sección activa según la URL actual.
const SECTION_PATH: Record<SectionId, string> = {
  servers:          '/servers',
  dashboard:        '/dashboard',
  ejecuciones:      '/general/ejecuciones',
  logs:             '/general/logs',
  'agent-host':     '/agent-host',
  'agent-host-logs': '/agent-host/logs',
  proyectos:        '/projects',
  agentes:          '/general/agentes',
  'system-prompts': '/general/system-prompts',
  providers:        '/general/providers',
  'mcp-catalog':    '/general/mcp-catalog',
  entorno:          '/general/entorno',
  escaneo:          '/general/escaneo',
};

// Deriva la sección activa a partir del path — soporta rutas anidadas
// (`/projects/:id/tab`, `/general/agentes/foo`, etc.).
const activeSection = computed<SectionId>(() => {
  const path = route.path;
  if (path === '/servers') return 'servers';
  // El más específico primero: `/agent-host/logs` empieza con `/agent-host`.
  if (path === '/agent-host/logs') return 'agent-host-logs';
  if (path === '/agent-host') return 'agent-host';
  if (path.startsWith('/projects')) return 'proyectos';
  const matches: SectionId[] = ['dashboard', 'ejecuciones', 'logs', 'agentes',
    'system-prompts', 'providers', 'mcp-catalog', 'entorno', 'escaneo'];
  for (const id of matches) {
    if (path === SECTION_PATH[id] || path.startsWith(`${SECTION_PATH[id]}/`)) return id;
  }
  return isAgentHost ? 'agent-host' : 'dashboard';
});

function goToSection(id: SectionId) {
  if (id === activeSection.value) return;
  if (isMobile()) sidebarCollapsed.value = true;
  void router.push(SECTION_PATH[id]);
}

function navigate(path: string) {
  if (isMobile()) sidebarCollapsed.value = true;
  void router.push(path);
}

// Cada proyecto es un hijo de "PROYECTOS"; el que está abierto expande un
// nivel más para mostrar sus tabs. Click sobre la fila del proyecto lleva a
// su overview.
const projectChildren = computed(() =>
  projectsStore.projects.map((p) => ({
    id: p.id,
    label: p.name || p.id,
    path: `/projects/${p.id}/overview`,
    children: PROJECT_TAB_ORDER
      .filter((t) => t.id !== 'board' || p.id !== projectsStore.activeProjectId || activeProjectHasStatuses.value)
      .map((t) => ({
        id: `${p.id}:${t.id}`,
        label: t.label,
        path: `/projects/${p.id}/${t.id}`,
      })),
  })),
);

const TABS = computed<
  Array<{
    id: SectionId;
    label: string;
    icon: string;
    group: string;
    children?: {
      id: string;
      label: string;
      path: string;
      children?: { id: string; label: string; path: string }[];
    }[];
  }>
>(() => {
  // Un agent-host tiene DOS pantallas y nada más: lo que ese proceso sabe de
  // sí mismo (provider, workspace, admisión, contra qué servers está
  // registrado) y su log. El resto del menú describe un server.
  if (isAgentHost) {
    return [
      { id: 'agent-host',      label: 'agent-host', icon: '', group: 'overview' },
      { id: 'agent-host-logs', label: 'logs',       icon: '', group: 'overview' },
    ];
  }

  // `agent-host` NO está acá. Era una entrada del menú del server que abría
  // otro proceso — el operador entraba a un server y encontraba un ítem que
  // hablaba con una máquina distinta, con otra credencial, sin que nada lo
  // dijera. Un agent-host ahora se elige en `/servers`, igual que un server.
  return [
  { id: 'dashboard',        label: 'dashboard',      icon: '', group: 'overview' },
  { id: 'ejecuciones',      label: 'ejecuciones',    icon: '', group: 'overview' },
  { id: 'logs',             label: 'logs',           icon: '', group: 'overview' },

  { id: 'proyectos',        label: 'proyectos',      icon: '', group: 'proyectos', children: projectChildren.value },

  { id: 'agentes',          label: 'agentes',        icon: '', group: 'global' },
  { id: 'system-prompts',   label: 'system prompts', icon: '', group: 'global' },
  { id: 'providers',        label: 'providers',      icon: '', group: 'global' },
  { id: 'mcp-catalog',      label: 'mcp catalog',    icon: '', group: 'global' },
  { id: 'entorno',          label: 'entorno',        icon: '', group: 'global' },
  { id: 'escaneo',          label: 'escaneo',        icon: '', group: 'global' },
  ];
});

// Keep the global active-executions cache warm and in sync with the server.
// One WS subscription at the shell level feeds the topbar chip, dashboard,
// project cards and per-tab live indicators without each component opening
// its own listener.
// Un agent-host no expone `/ws`. El corte va en `enabled` y NO adentro del
// callback: un `return` ahí descarta los mensajes pero el socket se abre
// igual, cierra, y el composable reintenta con backoff para siempre.
useServerEvents((msg) => {
  if (msg.type === 'execution:started' || msg.type === 'execution:updated') {
    activeExecutionsStore.ingest((msg as { log: unknown }).log, msg.type);
  } else if (msg.type === 'github:rate-limit') {
    rateLimitStore.ingest(msg);
  }
}, { enabled: !isAgentHost });

onMounted(async () => {
  // Ninguna de estas rutas existe en un agent-host. Sin este corte, entrar a
  // uno arrancaba con cuatro toasts de error que no describen ningún problema
  // real — el proceso está sano, es la app la que le está preguntando cosas
  // que no le corresponden.
  if (isAgentHost) return;
  void activeExecutionsStore.fetch();
  void rateLimitStore.fetch();
  // Projects list first — every scoped fetch depends on it (activeProjectId).
  try {
    await projectsStore.fetch();
  } catch (e) {
    toastStore.error(`Failed to load projects: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await providersStore.fetchConfig();
  } catch (e) {
    toastStore.error(`Failed to load config: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await globalConfigStore.fetch();
  } catch (e) {
    toastStore.error(`Failed to load globals: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await projectConfigStore.fetch();
  } catch (e) {
    toastStore.error(`Failed to load project config: ${e instanceof Error ? e.message : String(e)}`);
  }
});

// Reload project-scoped config whenever the active project changes.
watch(
  () => projectsStore.activeProjectId,
  async (next, prev) => {
    if (isAgentHost || !next || next === prev) return;
    try {
      await projectConfigStore.fetch();
    } catch (e) {
      toastStore.error(`Failed to load project config: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);
</script>

<template>
  <section class="app-shell">
    <!-- Window chrome — mac-lights on the left, breadcrumb centre, chip right. -->
    <header class="app-shell__chrome">
      <div class="app-shell__lights" aria-hidden="true">
        <span class="app-shell__light app-shell__light--r" />
        <span class="app-shell__light app-shell__light--y" />
        <span class="app-shell__light app-shell__light--g" />
      </div>
      <button
        type="button"
        class="app-shell__toggle"
        aria-label="Toggle menu"
        @click="toggleSidebar"
      >☰</button>
      <span class="app-shell__title">ia-flow — {{ activeSection }}</span>
      <!-- Qué daemon estás mirando. Con varios runners/* levantados es la
           diferencia entre leer los datos correctos y los de otra máquina. -->
      <button type="button" class="app-shell__server" title="cambiar de server" @click="goToServers">
        <span class="app-shell__server-dot" />{{ viewingServerLabel }}
      </button>
      <!-- Los dos leen del server: el rate limit de GitHub y las ejecuciones
           en curso. Un agent-host no tiene ni lo uno ni lo otro. -->
      <RateLimitChip v-if="!isAgentHost" />
      <ActiveExecutionsChip v-if="!isAgentHost" />
    </header>

    <div class="app-shell__body">
      <SettingsSidebar
        :tabs="TABS"
        :active-tab="activeSection"
        :active-path="route.path"
        :group-labels="TAB_GROUP_LABELS"
        :collapsed="sidebarCollapsed"
        @update:active-tab="goToSection"
        @navigate="navigate"
        @toggle-collapsed="toggleSidebar"
      />

      <main class="app-shell__main">
        <router-view />
      </main>
    </div>

    <Toast />
  </section>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
}

.app-shell__chrome {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.75rem;
  background: var(--panel-hi);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 50;
  /* En px (32) el contenido no entraba al subir la escala tipográfica: los
     chips miden var(--row-h) y con el padding pasan de 39px. El token va en
     rem para que la barra crezca con el texto. */
  height: var(--chrome-h);
  box-sizing: border-box;
}
.app-shell__lights { display: flex; gap: 0.35rem; }
.app-shell__light { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
.app-shell__light--r { background: #ff5f57; }
.app-shell__light--y { background: #febc2e; }
.app-shell__light--g { background: #28c840; }
.app-shell__toggle {
  display: none;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0 0.5rem;
  height: 20px;
  font: 500 var(--fs-chrome)/1 var(--font-mono);
}
.app-shell__server {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-left: 0.6rem;
  padding: 0.1rem 0.45rem;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg-dim);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}
.app-shell__server:hover { border-color: var(--accent); color: var(--accent); }
.app-shell__server-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}

.app-shell__title {
  flex: 1;
  text-align: center;
  font-size: var(--fs-chrome);
  color: var(--fg-dim);
  letter-spacing: 0.06em;
}

.app-shell__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: row;
  align-items: stretch;
}
.app-shell__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1.25rem 1.5rem 2.5rem;
  max-width: 1560px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

@media (max-width: 768px) {
  .app-shell__toggle { display: inline-flex; align-items: center; justify-content: center; }
  .app-shell__title { display: none; }
  .app-shell__main { padding: 0.75rem 0.75rem 2rem; }
}
</style>
