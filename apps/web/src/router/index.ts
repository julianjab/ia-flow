import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import SettingsView from '@/views/SettingsView.vue';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/settings' },
  { path: '/settings', name: 'settings', component: SettingsView },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
