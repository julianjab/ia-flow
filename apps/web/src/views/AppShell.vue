<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { currentBaseUrl } from '@/features/servers/selection';
import { useGithubSessionStore } from '@/stores/githubSession';
import { useTaskFocusStore } from '@/stores/taskFocus';

// El chrome: UNA barra de identidad arriba (R9) — qué app, contra qué server,
// quién sos en GitHub — y los destinos en un menú lateral. Mobile primero: en
// un teléfono el menú está guardado detrás de ☰ y entra desde la izquierda,
// sobre la pantalla; desde 768px queda fijo al costado y ☰ desaparece.

const session = useGithubSessionStore();

// Una tarea pedida desde afuera de la bandeja (una card del asistente) se abre en
// la bandeja: si se está en otra pantalla, se vuelve. La bandeja consume el pedido.
const taskFocus = useTaskFocusStore();
const route = useRoute();
const router = useRouter();
watch(
  () => taskFocus.request,
  (ref) => {
    if (ref && route.name !== 'inbox') void router.push({ name: 'inbox' });
  },
);

const host = computed(() => {
  try {
    return new URL(currentBaseUrl()).host;
  } catch {
    return currentBaseUrl();
  }
});

const LINKS = [
  { to: { name: 'inbox' }, label: 'Bandeja', hint: 'lo que te necesita' },
  { to: { name: 'config' }, label: 'Config', hint: 'pipelines, agentes, providers' },
  { to: { name: 'webhooks' }, label: 'Webhooks', hint: 'qué llega de GitHub y Slack' },
  { to: '/servers', label: 'Servidores', hint: 'cambiar de runner' },
] as const;

/** El menú abierto en un teléfono. Sobre 768px siempre se ve y esto no importa. */
const menuOpen = ref(false);

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') menuOpen.value = false;
}

watch(menuOpen, (open) => {
  if (typeof document === 'undefined') return;
  if (open) document.addEventListener('keydown', onKeydown);
  else document.removeEventListener('keydown', onKeydown);
});
// Ir a otra pantalla guarda el menú.
watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false;
  },
);
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="shell">
    <header class="bar">
      <button
        type="button"
        class="bar__menu"
        aria-controls="side-nav"
        :aria-expanded="menuOpen"
        :aria-label="menuOpen ? 'Cerrar el menú' : 'Abrir el menú'"
        @click="menuOpen = !menuOpen"
      >
        {{ menuOpen ? '✕' : '☰' }}
      </button>
      <span class="bar__brand">ia-flow</span>
      <RouterLink to="/servers" class="bar__server mono" title="Cambiar de server">{{ host }}</RouterLink>
      <span class="bar__gh">
        <template v-if="session.github">
          <span class="mono bar__login">@{{ session.github.login }}</span>
          <button type="button" class="btn btn--ghost" @click="session.logout()">Salir</button>
        </template>
        <button v-else type="button" class="btn" @click="session.requestLogin()">Entrar con GitHub</button>
      </span>
    </header>

    <div class="body">
      <div v-if="menuOpen" class="side-backdrop" aria-hidden="true" @click="menuOpen = false" />
      <nav id="side-nav" class="side" :data-open="menuOpen" aria-label="Secciones">
        <RouterLink v-for="l in LINKS" :key="l.label" :to="l.to" class="side__link">
          <span class="side__label">{{ l.label }}</span>
          <span class="side__hint">{{ l.hint }}</span>
        </RouterLink>
        <p v-if="session.github" class="side__who mono">@{{ session.github.login }}</p>
      </nav>

      <main class="main">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; }

/* Una sola barra, de `--tap-h` (R9, R12). */
.bar {
  position: sticky;
  top: env(safe-area-inset-top, 0px);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: var(--tap-h);
  padding: 0 0.75rem 0 0;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.bar__menu {
  flex: none;
  width: var(--tap-h);
  height: var(--tap-h);
  border: 0;
  background: none;
  color: var(--fg);
  font-size: var(--fs-body);
  cursor: pointer;
}
.bar__menu:hover { background: var(--panel-hi); }
.bar__brand { flex: none; font-family: var(--font-display); font-weight: 700; letter-spacing: var(--tracking-hd); text-transform: uppercase; color: var(--fg); }
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
/* En un teléfono el login no entra junto al server: va al pie del menú. */
.bar__login { display: none; }

/* Mobile primero (R8): el menú vive fuera de la pantalla y entra desde la izquierda, sobre todo. */
.side-backdrop {
  position: fixed;
  inset: calc(env(safe-area-inset-top, 0px) + var(--tap-h)) 0 0;
  z-index: 65;
  background: rgba(0, 0, 0, 0.6);
}
.side {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + var(--tap-h));
  bottom: 0;
  left: 0;
  z-index: 66;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(18rem, 85vw);
  padding: 0.5rem 0 calc(0.5rem + env(safe-area-inset-bottom, 0px));
  border-right: 1px solid var(--border);
  background: var(--panel);
  overflow-y: auto;
  transform: translateX(-100%);
  visibility: hidden;
  transition: transform 150ms ease, visibility 150ms;
}
.side[data-open='true'] { transform: translateX(0); visibility: visible; }
.side__link {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: var(--tap-h-lg);
  padding: 0.35rem 1rem;
  border-left: 3px solid transparent;
  color: var(--fg-mute);
}
.side__link:hover { background: var(--panel-hi); color: var(--fg); }
.side__label { font-size: var(--fs-body); font-weight: 500; }
.side__hint { color: var(--fg-dim); font-size: var(--fs-chrome); }
/* Dónde estás: el borde del acento y el texto fuerte (el video inverso es para chips). */
.side__link.router-link-exact-active { border-left-color: var(--accent); background: var(--panel-alt); color: var(--fg); }

.side__who { margin: auto 0 0; padding: 0.75rem 1rem 0; color: var(--fg-dim); font-size: var(--fs-chrome); }

.main { box-sizing: border-box; width: 100%; max-width: 72rem; margin: 0 auto; padding: 0.75rem 0.75rem 6rem; min-width: 0; }

/* Sobre --bp-shell: el menú queda fijo al costado y ☰ sobra. */
@media (min-width: 768px) {
  .bar__menu { display: none; }
  .bar { padding-left: 1rem; }
  .bar__server { max-width: 20rem; }
  .bar__login { display: inline; }
  .side__who { display: none; }
  .side-backdrop { display: none; }
  .body { display: grid; grid-template-columns: 13rem minmax(0, 1fr); }
  .side {
    position: sticky;
    top: calc(env(safe-area-inset-top, 0px) + var(--tap-h));
    width: auto;
    height: calc(100vh - var(--tap-h));
    transform: none;
    visibility: visible;
    transition: none;
  }
  .side__link { min-height: var(--tap-h); }
  .main { padding: 1rem 1.25rem 6rem; }
}
</style>
