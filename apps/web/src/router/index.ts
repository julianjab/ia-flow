import AgentHostConsole from '@/features/agent-host/AgentHostConsole.vue'
import AgentHostLogsView from '@/features/agent-host/AgentHostLogsView.vue'
import { getSelectedKind, getSelectedServer } from '@/features/servers/selection'
import AppShell from '@/views/AppShell.vue'
import DashboardView from '@/views/DashboardView.vue'
import GeneralView from '@/views/GeneralView.vue'
import ProjectDetailView from '@/views/ProjectDetailView.vue'
import ProjectsListView from '@/views/ProjectsListView.vue'
import ServerPickerView from '@/views/ServerPickerView.vue'
import { type RouteRecordRaw, createRouter, createWebHistory } from 'vue-router'

const routes: RouteRecordRaw[] = [
  // Fuera de AppShell a propósito: elegir server pasa ANTES de entrar a la
  // app, así que no lleva sidebar, ni topbar, ni stores de un server que
  // todavía no elegiste.
  { path: '/servers', name: 'servers', component: ServerPickerView },

  {
    path: '/',
    component: AppShell,
    children: [
      // La primera visita pasa por el selector; una vez elegido, la raíz
      // entra derecho a la pantalla principal de ESE proceso — que depende de
      // QUÉ elegiste: un agent-host no tiene dashboard —no tiene proyectos ni
      // ejecuciones—, así que mandarlo ahí lo dejaría en una pantalla que sólo
      // puede fallar.
      {
        path: '',
        redirect: () => {
          if (!getSelectedServer()) return '/servers'
          return getSelectedKind() === 'agent-host' ? '/agent-host' : '/dashboard'
        },
      },
      { path: 'dashboard', name: 'dashboard', component: DashboardView },

      // La consola del agent-host. Era un bundle aparte (`agent-host.html`)
      // porque habla con OTRO proceso y con otra credencial — pero eso no
      // obliga a que sea otra APP: para el operador es una pantalla más.
      //
      // Estas dos rutas son TODA la app cuando lo elegido es un agent-host: el
      // shell dibuja sólo estas dos entradas y ninguna de las de un server (ver
      // `isAgentHost` en AppShell.vue).
      { path: 'agent-host', name: 'agent-host', component: AgentHostConsole },
      { path: 'agent-host/logs', name: 'agent-host.logs', component: AgentHostLogsView },

      { path: 'general', redirect: '/general/agentes' },
      {
        // :detailId opcional — entrar al detalle de la fila abierta (o
        // `new` para crear una) queda reflejado en la URL en vez de vivir
        // solo en un ref local de la sección, que lo lee vía useRoute() y no
        // como prop (por eso el `props` de acá sigue mapeando sólo `tab`).
        // El nombre es genérico y no `:agentId` porque las tabs son
        // excluyentes y ya hay dos secciones que abren detalle así —agentes
        // y pipeline—: un param por sección serían dos opcionales seguidos,
        // que el router no puede desambiguar.
        path: 'general/:tab/:detailId?',
        name: 'general',
        component: GeneralView,
        props: (route) => ({ tab: route.params.tab }),
      },

      { path: 'projects', name: 'projects', component: ProjectsListView },
      { path: 'projects/:id', redirect: (to) => `/projects/${to.params.id}/overview` },
      {
        path: 'projects/:id/:tab/:detailId?',
        name: 'projects.detail',
        component: ProjectDetailView,
        props: (route) => ({ id: route.params.id, tab: route.params.tab }),
      },

      // Legacy /repos and /settings/* → new home so bookmarks don't 404.
      // Repos are now managed per-project at /projects/:id/repos.
      { path: 'repos', redirect: '/projects' },
      { path: 'settings', redirect: '/general/agentes' },
      { path: 'settings/:tab', redirect: '/general/agentes' },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

/**
 * Con un agent-host elegido, las rutas de server no se montan.
 *
 * El menú ya no las ofrece y `enter()` manda a la pantalla que corresponde,
 * pero eso cubre la navegación normal — no un bookmark, ni el `history.back()`
 * de quien venía de un server. Esas dos montan `DashboardView` o
 * `ProjectsListView`, que disparan `/api/*` contra un proceso que no las tiene:
 * 404s y toasts de error describiendo un problema que no existe.
 *
 * `/servers` queda afuera del corte por lo obvio: es de donde se sale.
 */
router.beforeEach((to) => {
  if (getSelectedKind() !== 'agent-host') return true
  if (to.path === '/servers' || to.path.startsWith('/agent-host')) return true
  return '/agent-host'
})

export default router
