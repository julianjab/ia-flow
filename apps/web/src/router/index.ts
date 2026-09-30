import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { hasChosenServer } from '@/features/servers/selection'
import AppShell from '@/views/AppShell.vue'
import InboxView from '@/views/InboxView.vue'
import ServerPickerView from '@/views/ServerPickerView.vue'
import WebhooksView from '@/views/WebhooksView.vue'

const routes: RouteRecordRaw[] = [
  // Fuera de AppShell a propósito: elegir server pasa ANTES de entrar a la
  // app, así que no lleva barra ni stores de un server que todavía no elegiste.
  { path: '/servers', name: 'servers', component: ServerPickerView },

  {
    path: '/',
    component: AppShell,
    children: [
      // Home: la bandeja sobre el board.
      { path: '', name: 'inbox', component: InboxView },
      { path: 'webhooks', name: 'webhooks', component: WebhooksView },
    ],
  },

  // Cualquier ruta de la web vieja (dashboard, projects, general…) cae en la bandeja.
  { path: '/:rest(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

/**
 * Sin server elegido no hay nada que mostrar: todo va a la pantalla de servers.
 * `/servers` queda afuera del corte por lo obvio: es de donde se sale.
 */
router.beforeEach((to) => {
  if (to.path === '/servers') return true
  return hasChosenServer() ? true : '/servers'
})

export default router
