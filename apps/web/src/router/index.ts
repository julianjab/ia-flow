import SettingsView from '@/views/SettingsView.vue'
import { type RouteRecordRaw, createRouter, createWebHistory } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/settings' },
  { path: '/settings', redirect: '/settings/proyecto' },
  { path: '/settings/:tab', name: 'settings', component: SettingsView, props: true },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
