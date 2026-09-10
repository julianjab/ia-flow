<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MobileTabBar from '@/components/MobileTabBar.vue';
import { GENERAL_SECTIONS, type GeneralSectionId } from '@/router/sections';
import SettingsSidebar from '@/components/SettingsSidebar.vue';
import ProjectSwitcherSheet from '@/features/projects/ProjectSwitcherSheet.vue';
import { useHasActionBar } from '@/composables/useActionBar';
import { useIsMobile } from '@/composables/useIsMobile';
import ActiveExecutionsChip from '@/components/ActiveExecutionsChip.vue';
import ChromeMoreSheet from '@/components/ChromeMoreSheet.vue';
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
  | 'aborted-runs'
  | 'logs'
  | 'agent-host'
  | 'agent-host-logs'
  | 'proyectos'
  | 'agentes'
  | 'pipeline'
  | 'acciones'
  | 'tools'
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
  { id: 'agentes',        label: 'agentes' },
  { id: 'pipeline',       label: 'pipeline' },
  { id: 'acciones',       label: 'acciones' },
  { id: 'tools',          label: 'tools' },
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

/**
 * Bajo 768px el sidebar NO se renderiza y manda la tab bar; sobre 768px, al
 * revés. Es un `v-if`, no un `display: none`: un pie que nadie va a ver no se
 * monta, y el drawer mobile —con su estado, su backdrop y el ☰ que lo abría—
 * deja de existir. El ☰ ahora es el tab `Más`, y navega.
 *
 * El colapso del sidebar queda como lo que siempre fue en desktop: una
 * preferencia del usuario, sin default que dependa del ancho.
 */
const { isMobile: mobile } = useIsMobile();
const isMobile = () => mobile.value;
const sidebarCollapsed = ref(false);
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; }

const projectSheetOpen = ref(false);
/** El `⋯` de la barra: lo que ya no se dibuja en ella (rate limit, conteo de
 *  activos, server). Ver `ChromeMoreSheet`. */
const moreSheetOpen = ref(false);

/**
 * La sección, como migaja de pan.
 *
 * Dentro de un proyecto la barra ya dice el proyecto, así que lo que falta es
 * el TAB — `tareas`, `ejecuciones`. Fuera de un proyecto la sección misma es
 * la identidad de la pantalla. En los dos casos es una sola palabra: es una
 * migaja, no un título (R9).
 */
const breadcrumb = computed<string>(() => {
  const tab = route.path.match(/^\/projects\/[^/]+\/([^/]+)/)?.[1];
  if (tab) return PROJECT_TAB_ORDER.find((t) => t.id === tab)?.label ?? tab;
  return activeSection.value.replace(/-/g, ' ');
});

/**
 * `←` — volver.
 *
 * Es historial y no una ruta fija: la barra no sabe de dónde viniste, y
 * mandarte siempre a `/projects` desde una tarea abierta sería perder el
 * listado en el que estabas. Sin historial propio (entraste por un deep link)
 * cae al listado de proyectos, que es el único destino que siempre existe.
 */
function goBack() {
  if (window.history.length > 1) router.back();
  else void router.push('/projects');
}

/**
 * ¿Hay algo corriendo? — el punto vivo de la barra.
 *
 * Se pinta sólo cuando el store CONTESTÓ y hay runs: un punto quieto insinúa
 * actividad que no hay, y con el socket caído sería una mentira sobre el
 * estado del server (DESIGN_SYSTEM · vocabulario de estado).
 */
const anythingRunning = computed(
  () => activeExecutionsStore.loaded && activeExecutionsStore.activeCount > 0,
);

/**
 * Dónde SÍ va la tab bar.
 *
 * Fuera del agent-host: otro proceso, otra credencial, su propia navegación.
 * `/servers` no hace falta filtrarlo — es una ruta top-level que ni siquiera
 * monta este shell. El detalle de tarea tampoco muestra la barra, pero eso lo
 * resuelve él: es pantalla completa con su propia barra de acciones, y dos
 * barras se comerían 108px de alto en chrome.
 *
 * `hasActionBar` es la forma general de eso mismo (R4): mientras haya un
 * `StickyActionBar` montado —el pie de cualquier formulario de configuración—
 * la tab bar no se dibuja. El pulgar no puede quedar entre "guardar" y
 * "cambiar de pantalla".
 */
const { hasActionBar } = useHasActionBar();
const showTabBar = computed(() => mobile.value && !isAgentHost && !hasActionBar.value);

/** El proyecto activo, como lo muestra el header mobile. */
const activeProjectLabel = computed(() => {
  const id = projectsStore.activeProjectId;
  if (!id) return null;
  return projectsStore.projects.find((p) => p.id === id)?.name ?? id;
});

/**
 * Cambiar de proyecto mantiene el TAB: se navega al mismo lugar del proyecto
 * nuevo, no a su raíz. Cambiar de contexto no debería costar volver a buscar
 * dónde estabas.
 */
function switchProject(projectId: string) {
  projectSheetOpen.value = false;
  if (projectId === projectsStore.activeProjectId) return;
  const tab = route.path.match(/^\/projects\/[^/]+\/([^/]+)/)?.[1] ?? 'tareas';
  void router.push(`/projects/${projectId}/${tab}`);
}

const route = useRoute();
const router = useRouter();

// Cada sección de primer nivel apunta a una ruta fija. Se usa para: navegar
// al hacer clic en el padre + resaltar la sección activa según la URL actual.
const SECTION_PATH: Record<SectionId, string> = {
  servers:          '/servers',
  dashboard:        '/dashboard',
  ejecuciones:      '/general/ejecuciones',
  'aborted-runs':   '/general/aborted-runs',
  logs:             '/general/logs',
  'agent-host':     '/agent-host',
  'agent-host-logs': '/agent-host/logs',
  proyectos:        '/projects',
  // Los nueve `/general/*` salen de la lista compartida: escritos otra vez acá
  // eran la segunda copia que se podía quedar vieja, que es lo mismo que
  // dejaba a `Más` prometiendo once destinos y llevando a uno.
  ...(Object.fromEntries(GENERAL_SECTIONS.map((s) => [s.id, s.path])) as Record<
    GeneralSectionId,
    string
  >),
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
  const matches: SectionId[] = ['dashboard', 'ejecuciones', 'aborted-runs', 'logs', 'agentes',
    'system-prompts', 'providers', 'mcp-catalog', 'entorno', 'escaneo'];
  for (const id of matches) {
    if (path === SECTION_PATH[id] || path.startsWith(`${SECTION_PATH[id]}/`)) return id;
  }
  return isAgentHost ? 'agent-host' : 'dashboard';
});

function goToSection(id: SectionId) {
  if (id === activeSection.value) return;
  // Una sección con hijos (hoy sólo "proyectos") todavía tiene un nivel más
  // para elegir — colapsar acá escondería el árbol justo cuando el usuario
  // quiere seguir bajando. Sólo las hojas (sin hijos) cierran el sidebar.
  const hasChildren = !!TABS.value.find((t) => t.id === id)?.children?.length;
  if (isMobile() && !hasChildren) sidebarCollapsed.value = true;
  void router.push(SECTION_PATH[id]);
}

function navigate(path: string, hasChildren = false) {
  if (isMobile() && !hasChildren) sidebarCollapsed.value = true;
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
    // `board` ya no es un tab: es la otra VISTA de Tareas, y se elige con el
    // segmentado de esa pantalla. Un destino aparte para el mismo conjunto de
    // tareas obligaba a decidir por dónde entrar antes de saber qué buscabas.
    children: PROJECT_TAB_ORDER
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
  { id: 'aborted-runs',     label: 'runs recuperables', icon: '', group: 'overview' },
  { id: 'logs',             label: 'logs',           icon: '', group: 'overview' },

  { id: 'proyectos',        label: 'proyectos',      icon: '', group: 'proyectos', children: projectChildren.value },

  // La configuración del server sale de una lista compartida con `Más`: son
  // los mismos destinos, y tenerlos dos veces era lo que dejaba a `Más`
  // prometiendo once y llevando a uno (ver `router/sections.ts`).
  ...GENERAL_SECTIONS.map((sec) => ({
    id: sec.id,
    label: sec.label,
    icon: '',
    group: 'global',
  })),
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
    <!-- LA barra de identidad — una sola, en cualquier ancho (R9, R12).
         `←` · proyecto (abre el switcher) · sección como migaja · punto vivo ·
         `⋯`. Nada más: el id del proyecto y la URL del source viven en
         `overview`, y el rate limit y el conteo de activos en el sheet de `⋯`.
         Antes esto eran DOS encabezados —éste y el `.pd-header` del detalle de
         proyecto— que repetían el mismo nombre y sumaban 200px de alto en un
         teléfono. -->
    <header class="app-shell__chrome">
      <!-- El primer blanco de la barra: en desktop abre y cierra el sidebar;
           en mobile no hay sidebar que plegar y el gesto que falta es volver. -->
      <button
        v-if="!mobile"
        type="button"
        class="app-shell__icon"
        aria-label="Plegar el menú"
        @click="toggleSidebar"
      >☰</button>
      <button
        v-else
        type="button"
        class="app-shell__icon"
        aria-label="Volver"
        @click="goBack"
      >←</button>

      <!-- La identidad: qué proyecto y en qué parte de él. Bajo --bp-shell van
           en dos líneas dentro de la misma fila de --tap-h; sobre él, en una
           con el separador. El proyecto es un botón porque cambiarlo es la
           acción más frecuente de la barra. -->
      <div class="app-shell__identity">
        <button
          v-if="activeProjectLabel"
          type="button"
          class="app-shell__project"
          :aria-label="`Proyecto ${activeProjectLabel} — cambiar`"
          @click="projectSheetOpen = true"
        >
          <span class="app-shell__project-name">{{ activeProjectLabel }}</span>
          <span class="app-shell__project-caret" aria-hidden="true">⌄</span>
        </button>
        <span v-else class="app-shell__project-name app-shell__project-name--static">ia-flow</span>
        <span class="app-shell__crumb">{{ breadcrumb }}</span>
      </div>

      <!-- Sobre --bp-shell hay ancho de sobra y los dos chips son un dato que
           se mira de reojo. Bajo el breakpoint no entran, y su contenido vive
           en el sheet de `⋯`: es lo que baja el chrome de 200px a 44. -->
      <template v-if="!mobile">
        <button type="button" class="app-shell__server" title="cambiar de server" @click="goToServers">
          <span class="app-shell__server-dot" />{{ viewingServerLabel }}
        </button>
        <RateLimitChip v-if="!isAgentHost" />
        <ActiveExecutionsChip v-if="!isAgentHost" />
      </template>

      <!-- El punto vivo: lo único del estado del server que vale un blanco
           propio en la barra. Se dibuja SÓLO si hay algo corriendo — un punto
           quieto insinúa actividad que no hay. -->
      <span
        v-if="mobile && !isAgentHost && anythingRunning"
        class="app-shell__icon app-shell__live"
        :title="`${activeExecutionsStore.activeCount} en curso`"
      ><span class="live-dot" aria-hidden="true"></span></span>

      <!-- `⋯` va en CUALQUIER ancho: bajo --bp-shell porque es donde viven el
           rate limit y el conteo de activos que la barra ya no dibuja, y en
           desktop porque es donde quedó la pausa de polling del proyecto —
           que antes estaba en el `.pd-header` que este cambio borra. Sobre el
           breakpoint el sheet se dibuja centrado, no desde abajo. -->
      <button
        type="button"
        class="app-shell__icon"
        aria-label="Estado del server"
        :aria-expanded="moreSheetOpen"
        @click="moreSheetOpen = true"
      >⋯</button>
    </header>

    <div class="app-shell__body">
      <SettingsSidebar
        v-if="!mobile"
        :tabs="TABS"
        :active-tab="activeSection"
        :active-path="route.path"
        :group-labels="TAB_GROUP_LABELS"
        :collapsed="sidebarCollapsed"
        @update:active-tab="goToSection"
        @navigate="navigate"
        @toggle-collapsed="toggleSidebar"
      />

      <main class="app-shell__main" :class="{ 'has-tabbar': showTabBar }">
        <router-view />
      </main>
    </div>

    <!-- La tab bar no aparece en /servers ni en el agent-host: el primero es
         de dónde se elige el server (no hay proyecto todavía) y el segundo
         tiene su propio contexto y credencial. -->
    <MobileTabBar v-if="showTabBar" :project-id="projectsStore.activeProjectId" />

    <ChromeMoreSheet
      :open="moreSheetOpen"
      :server-label="viewingServerLabel"
      :project-id="isAgentHost ? null : projectsStore.activeProjectId"
      @close="moreSheetOpen = false"
      @go-servers="moreSheetOpen = false; goToServers()"
    />

    <ProjectSwitcherSheet
      :open="projectSheetOpen"
      @close="projectSheetOpen = false"
      @pick="switchProject"
    />

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
  gap: 0.3rem;
  padding: 0 0.25rem;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 50;
  /* --tap-h y no --chrome-h: TODO lo que hay en esta fila se toca (R1, R12).
     El token viejo (2.25rem) sigue existiendo porque los overlays fijos que
     deben quedar por debajo de la barra calculan su `top` contra ella. */
  height: var(--tap-h);
  box-sizing: border-box;
}

/* Los blancos de ícono de la barra: ←/☰, el punto vivo y ⋯. Cuadrados de
   --tap-h — es lo que los hace tocables sin que la barra crezca. */
.app-shell__icon {
  flex: 0 0 auto;
  width: var(--tap-h);
  height: var(--tap-h);
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.app-shell__icon:hover { color: var(--fg); }
.app-shell__live { cursor: default; }

/* La identidad ocupa lo que sobra y CEDE: el nombre del proyecto se trunca en
   vez de empujar los íconos fuera de la barra. */
.app-shell__identity {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0;
  padding: 0 0.25rem;
}

.app-shell__project {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
  padding: 0;
  background: none;
  border: none;
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  font-weight: 500;
  line-height: 1.25;
  text-align: left;
  cursor: pointer;
}
.app-shell__project:hover { color: var(--accent); }
.app-shell__project-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-shell__project-name--static {
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  font-weight: 500;
  line-height: 1.25;
  color: var(--fg);
}
.app-shell__project-caret { flex: 0 0 auto; color: var(--fg-dimmer); }

/* La migaja: segunda línea bajo --bp-shell, misma línea arriba. En los dos
   casos es una palabra en caja alta — no compite con el nombre del proyecto,
   lo completa. */
.app-shell__crumb {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
  line-height: 1.25;
}
@media (min-width: 768px) {
  .app-shell__identity { flex-direction: row; align-items: baseline; gap: 0.5rem; }
  .app-shell__crumb::before { content: '· '; color: var(--fg-dimmer); }
}

/* La última fila de una lista no puede quedar tapada por la tab bar. */
.app-shell__main.has-tabbar { padding-bottom: 60px; }

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
  width: 100%;
  box-sizing: border-box;
}

/* Los chips y el server sólo se renderizan sobre --bp-shell (`v-if` en el
   template), así que ya no hay nada que esconder acá: bajo el breakpoint la
   barra tiene cinco blancos de --tap-h y ninguno puede desbordar. Lo que queda
   es el respiro de la página. */
@media (max-width: 768px) {
  .app-shell__main { padding: 0.75rem 0.75rem 2rem; }
  /* Bajo la tab bar el padding de abajo se suma al de la barra. */
  .app-shell__main.has-tabbar { padding-bottom: calc(60px + 0.75rem); }
}

/* Bajo --bp-stack, de los chips sobra la ETIQUETA — el glifo y el número son
   el dato ("◆ 4682/5000" se entiende sin el "gh api"). Sigue acá porque el
   sidebar abierto bajo --bp-split deja la barra sin ancho de sobra.

   `:deep()` porque los chips son componentes hijos y este bloque es `scoped`:
   sin eso la regla nunca los alcanza. */
@media (max-width: 1100px) {
  .app-shell__chrome :deep(.chip__label) { display: none; }
  .app-shell__chrome :deep(.chip) { padding: 0 0.45rem; }
}
</style>
