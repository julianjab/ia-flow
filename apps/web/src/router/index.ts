import AppShell from '@/views/AppShell.vue'
import GeneralSectionView from '@/views/GeneralSectionView.vue'
import GeneralView from '@/views/GeneralView.vue'
import ProjectDetailView from '@/views/ProjectDetailView.vue'
import ProjectsListView from '@/views/ProjectsListView.vue'
import ReposView from '@/views/ReposView.vue'
import { type RouteRecordRaw, createRouter, createWebHistory } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', redirect: '/general' },

      { path: 'general', name: 'general', component: GeneralView },
      {
        path: 'general/:section',
        name: 'general.section',
        component: GeneralSectionView,
        props: true,
      },

      { path: 'projects', name: 'projects', component: ProjectsListView },
      { path: 'projects/:id', redirect: (to) => `/projects/${to.params.id}/overview` },
      {
        path: 'projects/:id/:tab',
        name: 'projects.detail',
        component: ProjectDetailView,
        props: true,
      },

      { path: 'repos', name: 'repos', component: ReposView },

      // Legacy /settings/* → new home so bookmarks don't 404.
      { path: 'settings', redirect: '/general' },
      { path: 'settings/:tab', redirect: '/general' },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
