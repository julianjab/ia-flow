<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { useIsMobile } from '@/composables/useIsMobile';
import { useInboxStore } from '@/features/inbox/store';
import { currentBaseUrl } from '@/features/servers/selection';
import { useAssistantStore } from '@/stores/assistant';
import { useGithubSessionStore } from '@/stores/githubSession';
import { useTaskFocusStore } from '@/stores/taskFocus';
import BottomSheet from '@/ui/BottomSheet.vue';
import TabBar, { type TabItem } from '@/ui/TabBar.vue';

// El chrome: UNA barra de identidad arriba (R9) — qué app, contra qué server,
// quién sos en GitHub — y los destinos. Mobile primero: en un teléfono los
// destinos son una tab bar al pie (el asistente es una pestaña más, no una
// burbuja flotante) y el server se cambia desde su chip en la barra; desde
// 768px el menú queda fijo al costado y el asistente vuelve a su burbuja.

const session = useGithubSessionStore();
const assistant = useAssistantStore();
const inbox = useInboxStore();
const { isMobile } = useIsMobile();

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

/** Las iniciales del login, para el avatar del teléfono. */
const initials = computed(() => (session.github?.login ?? '').slice(0, 2).toUpperCase());
/** La cuenta de GitHub en un teléfono: un sheet con quién sos y Salir (R6: nada anclado). */
const accountOpen = ref(false);
function logout() {
  accountOpen.value = false;
  session.logout();
}

const TABS = computed<TabItem[]>(() => [
  { id: 'inbox', label: 'Bandeja', to: { name: 'inbox' }, badge: inbox.queue.headline.decisions },
  { id: 'assistant', label: 'Asistente', active: assistant.isOpen, dot: assistant.unread },
  { id: 'webhooks', label: 'Webhooks', to: { name: 'webhooks' } },
  { id: 'config', label: 'Config', to: { name: 'config' } },
]);
function onTab(id: string) {
  if (id === 'assistant') assistant.open();
}

const LINKS = [
  { to: { name: 'inbox' }, label: 'Bandeja', hint: 'lo que te necesita' },
  { to: { name: 'config' }, label: 'Config', hint: 'pipelines, agentes, providers' },
  { to: { name: 'webhooks' }, label: 'Webhooks', hint: 'qué llega de GitHub y Slack' },
  { to: '/servers', label: 'Runners', hint: 'cambiar de runner' },
] as const;
</script>

<template>
  <div class="shell">
    <header class="bar">
      <span class="bar__brand">ia-flow</span>
      <RouterLink to="/servers" class="bar__server mono" title="Cambiar de runner">
        <span class="bar__dot" aria-hidden="true" /><span class="bar__host">{{ host }}</span><span class="bar__caret" aria-hidden="true">▾</span>
      </RouterLink>
      <span class="bar__gh">
        <button
          v-if="session.github && isMobile"
          type="button"
          class="bar__avatar"
          :aria-label="`Tu cuenta: @${session.github.login}`"
          @click="accountOpen = true"
        >
          {{ initials }}
        </button>
        <template v-else-if="session.github">
          <span class="mono bar__login">@{{ session.github.login }}</span>
          <button type="button" class="btn btn--ghost" @click="session.logout()">Salir</button>
        </template>
        <button v-else type="button" class="btn" @click="session.requestLogin()">{{ isMobile ? 'Entrar' : 'Entrar con GitHub' }}</button>
      </span>
    </header>

    <div class="body">
      <nav v-if="!isMobile" class="side" aria-label="Secciones">
        <RouterLink v-for="l in LINKS" :key="l.label" :to="l.to" class="side__link">
          <span class="side__label">{{ l.label }}</span>
          <span class="side__hint">{{ l.hint }}</span>
        </RouterLink>
      </nav>

      <main class="main">
        <RouterView />
      </main>
    </div>

    <TabBar v-if="isMobile" :items="TABS" @press="onTab">
      <template #icon="{ id }">
        <svg v-if="id === 'inbox'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M4 13h4.5l1 2h5l1-2H20" /></svg>
        <span v-else-if="id === 'assistant'" class="tab-ai">✦</span>
        <svg v-else-if="id === 'webhooks'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v8M8 8l4 4 4-4" /><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
      </template>
    </TabBar>

    <BottomSheet :open="accountOpen" title="Tu cuenta" @close="accountOpen = false">
      <div class="account">
        <p class="account__who">Conectado como <span class="mono">@{{ session.github?.login }}</span>. Lo que hagas sobre el board queda firmado con este usuario.</p>
        <button type="button" class="btn btn--danger" @click="logout">Salir de GitHub</button>
      </div>
    </BottomSheet>
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
.bar__brand { flex: none; padding-left: 1rem; font-family: var(--font-display); font-size: var(--fs-num); font-weight: 600; color: var(--fg); }
/* `a:hover` global pinta el fondo: se redefine en cada :hover de un link. */
.bar__server {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap-h);
  gap: 0.35rem;
  min-width: 0;
  max-width: 12rem;
  min-height: var(--tap-h-sm);
  margin-left: auto;
  padding: 0 0.6rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--fg-mute);
  font-size: var(--fs-chrome);
}
.bar__server:hover { background: transparent; border-color: var(--border-hi); color: var(--fg); }
.bar__dot { flex: none; width: 0.4rem; height: 0.4rem; border-radius: 50%; background: var(--accent); }
.bar__host { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar__caret { flex: none; color: var(--fg-dim); font-size: var(--fs-micro); }
.bar__avatar {
  width: var(--tap-h);
  height: var(--tap-h);
  border: 0;
  background: none;
  color: var(--fg-mute);
  font: 600 var(--fs-chrome) var(--font-body);
  cursor: pointer;
}
/* El círculo es más chico que el blanco táctil (R11: el área es la del botón). */
.bar__avatar { background: radial-gradient(circle, var(--panel-hi) 0 1rem, transparent 1rem); }
.bar__avatar:hover { color: var(--fg); }
.tab-ai { color: var(--ai); font-size: 1.1rem; line-height: 1; }
.account { display: flex; flex-direction: column; gap: 0.75rem; padding: 0 1rem; }
.account__who { margin: 0; color: var(--fg-mute); }
.bar__gh { display: flex; align-items: center; gap: 0.4rem; flex: none; font-size: var(--fs-body-sm); }
/* En un teléfono el login es el avatar: el @ va al sheet de la cuenta. */
.bar__login { display: none; }

/* El menú lateral es de desktop (en un teléfono, la tab bar). */
.side {
  position: sticky;
  top: calc(env(safe-area-inset-top, 0px) + var(--tap-h));
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--tap-h));
  padding: 0.5rem 0;
  border-right: 1px solid var(--border);
  background: var(--panel);
  overflow-y: auto;
}
.side__link {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: var(--tap-h);
  padding: 0.35rem 1rem;
  border-left: 3px solid transparent;
  color: var(--fg-mute);
}
.side__link:hover { background: var(--panel-hi); color: var(--fg); }
.side__label { font-size: var(--fs-body); font-weight: 500; }
.side__hint { color: var(--fg-dim); font-size: var(--fs-chrome); }
/* Dónde estás: el borde del acento y el texto fuerte (el video inverso es para chips). */
.side__link.router-link-exact-active { border-left-color: var(--accent); background: var(--panel-alt); color: var(--fg); }

/* El pie deja lugar a la tab bar fija (`--tap-h-lg` + su padding + la zona segura). */
.main { box-sizing: border-box; width: 100%; max-width: 72rem; margin: 0 auto; padding: 0.75rem 0.75rem calc(var(--tap-h-lg) + 1.5rem + env(safe-area-inset-bottom, 0px)); min-width: 0; }

/* Sobre --bp-shell: el menú queda fijo al costado y ☰ sobra. */
@media (min-width: 768px) {
  .bar__server { max-width: 20rem; margin-left: 0.5rem; }
  .bar__gh { margin-left: auto; }
  .bar__login { display: inline; }
  .body { display: grid; grid-template-columns: 13rem minmax(0, 1fr); }
  .main { padding: 1rem 1.25rem 6rem; }
}
</style>
