<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { currentBaseUrl } from '@/features/servers/selection';
import { useGithubSessionStore } from '@/stores/githubSession';

// El chrome: UNA barra de identidad (R9) — qué app, contra qué server, quién sos
// en GitHub — y tres destinos. Bajo 768px la navegación baja a una segunda fila
// de la misma barra; arriba comparten fila.

const session = useGithubSessionStore();

const host = computed(() => {
  try {
    return new URL(currentBaseUrl()).host;
  } catch {
    return currentBaseUrl();
  }
});
</script>

<template>
  <div class="shell">
    <header class="bar">
      <div class="bar__id">
        <span class="bar__brand">ia-flow</span>
        <RouterLink to="/servers" class="bar__server mono" title="Cambiar de server">{{ host }}</RouterLink>
        <span class="bar__gh">
          <template v-if="session.github">
            <span class="mono">@{{ session.github.login }}</span>
            <button type="button" class="btn btn--ghost" @click="session.logout()">Salir</button>
          </template>
          <button v-else type="button" class="btn" @click="session.requestLogin()">Entrar con GitHub</button>
        </span>
      </div>
      <nav class="bar__nav" aria-label="Secciones">
        <RouterLink :to="{ name: 'inbox' }" class="bar__link">Bandeja</RouterLink>
        <RouterLink :to="{ name: 'webhooks' }" class="bar__link">Webhooks</RouterLink>
        <RouterLink to="/servers" class="bar__link">Servidores</RouterLink>
      </nav>
    </header>

    <main class="main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; }
.bar {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.bar__id { display: flex; align-items: center; gap: 0.75rem; min-height: var(--tap-h); padding: 0 0.75rem; min-width: 0; }
.bar__brand { font-family: var(--font-display); font-weight: 700; letter-spacing: var(--tracking-hd); text-transform: uppercase; color: var(--fg); }
/* `a:hover` global pinta el fondo: se redefine en cada :hover de un link. */
.bar__server {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap-h);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-dim);
  font-size: var(--fs-chrome);
}
.bar__server:hover { background: transparent; color: var(--fg); }
.bar__gh { display: flex; align-items: center; gap: 0.4rem; margin-left: auto; flex: none; font-size: var(--fs-body-sm); }

.bar__nav { display: flex; border-top: 1px solid var(--border-mute); }
.bar__link {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--tap-h);
  color: var(--fg-mute);
  font-size: var(--fs-body-sm);
  font-weight: 500;
}
.bar__link:hover { background: var(--panel-hi); color: var(--fg); }
/* Selección: video inverso (DESIGN_SYSTEM «Selección»). */
.bar__link.router-link-exact-active,
.bar__link.router-link-exact-active:hover { background: var(--accent); color: var(--panel); }

.main { max-width: 72rem; margin: 0 auto; padding: 0.75rem 0.75rem 6rem; }

@media (min-width: 768px) {
  .bar { flex-direction: row; align-items: center; padding-right: 0.75rem; }
  .bar__id { flex: 1; }
  .bar__nav { flex: none; border-top: 0; }
  .bar__link { flex: none; padding: 0 1rem; }
  .bar__gh { margin-left: 1rem; }
  .bar__server { max-width: 20rem; }
  .main { padding: 1rem 1.25rem 6rem; }
}
</style>
