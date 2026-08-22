import AppShell from '@/views/AppShell.vue'
import DashboardView from '@/views/DashboardView.vue'
import GeneralView from '@/views/GeneralView.vue'
import ProjectDetailView from '@/views/ProjectDetailView.vue'
import ProjectsListView from '@/views/ProjectsListView.vue'
import { type RouteRecordRaw, createRouter, createWebHistory } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', name: 'dashboard', component: DashboardView },

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
