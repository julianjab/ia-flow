<script setup lang="ts">
import { RouterView, useRoute } from 'vue-router';
import AssistantLauncher from '@/features/assistant/AssistantLauncher.vue';
import GithubLoginSheet from '@/features/github-login/GithubLoginSheet.vue';

const route = useRoute();
</script>

<template>
  <RouterView />
  <!-- Los dos overlays globales, montados UNA vez: el asistente (único punto de
       entrada, lo abre también la bandeja) y el login de GitHub (lo pide
       cualquiera que necesite firmar una acción). En la pantalla de servers
       todavía no hay un server elegido con el que hablar. -->
  <template v-if="route.path !== '/servers'">
    <AssistantLauncher />
    <GithubLoginSheet />
  </template>
</template>
