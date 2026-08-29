import AgentHostConsole from '@/features/agent-host/AgentHostConsole.vue'
import { getSelectedServer } from '@/features/servers/selection'
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
      // entra derecho al dashboard de ESE server.
      { path: '', redirect: () => (getSelectedServer() ? '/dashboard' : '/servers') },
      { path: 'dashboard', name: 'dashboard', component: DashboardView },

      // La consola del agent-host. Era un bundle aparte (`agent-host.html`) porque
      // habla con OTRO proceso y con otra credencial — pero eso no obliga a
      // que sea otra APP: para el operador es una pantalla más, y tenerla
      // afuera significaba dos ventanas, dos .app y dos lugares donde buscar.
      // El componente ya era autosuficiente (no usa Pinia ni el router), así
      // que montarlo acá no le cambia nada.
      { path: 'agent-host', name: 'agent-host', component: AgentHostConsole },

      { path: 'general', redirect: '/general/agentes' },
      {
        // :agentId opcional — entrar al detalle de un agente (o agentId=new
        // para crear uno) queda reflejado en la URL en vez de vivir solo en
        // el ref local de AgentesSection (que lo lee vía useRoute(), no como
        // prop — por eso el `props` de acá sigue mapeando sólo `tab`).
        path: 'general/:tab/:agentId?',
        name: 'general',
        component: GeneralView,
        props: (route) => ({ tab: route.params.tab }),
      },

      { path: 'projects', name: 'projects', component: ProjectsListView },
      { path: 'projects/:id', redirect: (to) => `/projects/${to.params.id}/overview` },
      {
        path: 'projects/:id/:tab/:agentId?',
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

export default router
