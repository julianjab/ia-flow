<script setup lang="ts">
import DevctlPanel from '@/features/devctl/DevctlPanel.vue';
import { RouterLink } from 'vue-router';
</script>

<template>
  <main class="devctl">
    <header class="devctl__hd">
      <RouterLink to="/servers" class="devctl__back">&larr; servers</RouterLink>
      <h1 class="devctl__title">Procesos locales</h1>
      <p class="devctl__sub">
        Server, web y los dos agent-host de dev — levantalos, elegí modo y puerto, y pará los que
        gestiona esta app.
      </p>
    </header>

    <DevctlPanel />
  </main>
</template>

<style scoped>
.devctl {
  max-width: 62rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 3rem;
}

.devctl__hd {
  margin-bottom: 2rem;
}
.devctl__back {
  display: inline-block;
  margin-bottom: 0.6rem;
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
}
.devctl__back:hover {
  background: none;
  color: var(--accent);
}
.devctl__title {
  margin: 0;
}
.devctl__sub {
  margin: 0.35rem 0 0;
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
}
</style>
