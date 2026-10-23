<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { useIsMobile } from '@/composables/useIsMobile';
import EpicDetailDrawer from '@/features/inbox/EpicDetailDrawer.vue';
import { useInboxStore } from '@/features/inbox/store';
import TaskDetailDrawer from '@/features/inbox/TaskDetailDrawer.vue';
import { currentBaseUrl } from '@/features/servers/selection';
import { useAssistantStore } from '@/stores/assistant';
import { useGithubSessionStore } from '@/stores/githubSession';
import { useTaskFocusStore } from '@/stores/taskFocus';
import BottomSheet from '@/ui/BottomSheet.vue';
import TabBar, { type TabItem } from '@/ui/TabBar.vue';

// El chrome (v5, la UI unificada con el menú de Mac): UNA barra arriba con el runner y cómo está
// («2 corriendo · 1 en cola · 1 libre»), que lleva a elegir otro; y las tres vistas de la bandeja
// —Para mí, En curso, Próximo— como destinos. En un teléfono son la tab bar al pie, con el
// asistente como cuarta pestaña, y lo que se consulta (Mejoras, Webhooks, Config, la cuenta) va en
// el sheet «Más» del avatar; desde 768px, un menú lateral con todo.
//
// La bandeja vive mientras la app está abierta: el shell la arranca y la corta (stream incluido),
// así cambiar de vista no la recarga. Los detalles de una tarea y de una épica se montan acá: se
// abren desde cualquier vista.

const session = useGithubSessionStore();
const assistant = useAssistantStore();
const inbox = useInboxStore();
const { isMobile } = useIsMobile();

onMounted(() => {
  inbox.reloadPrefs();
  inbox.start();
});
onBeforeUnmount(() => inbox.stop());

// Una tarea pedida desde afuera de «Para mí» (una card del asistente) se abre ahí: si se está en
// otra pantalla, se vuelve. «Para mí» consume el pedido.
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

/** Cómo está el runner, en una línea: lo que corre, lo que espera y cuánto lugar queda. */
const status = computed(() => {
  if (inbox.sections.pipeline !== 'ready') return inbox.error ? 'no responde' : 'conectando…';
  const p = inbox.queue.pipeline;
  const free = p.free !== undefined ? ` · ${p.free} ${p.free === 1 ? 'libre' : 'libres'}` : '';
  return `${p.running} corriendo · ${p.waiting} en cola${free}`;
});
const live = computed(() => inbox.streamState === 'live');

/** Las iniciales del login, para el avatar del teléfono. */
const initials = computed(() => (session.github?.login ?? '').slice(0, 2).toUpperCase());
const moreOpen = ref(false);
function logout() {
  moreOpen.value = false;
  session.logout();
}

const decisions = computed(() => inbox.queue.headline.decisions);
const TABS = computed<TabItem[]>(() => [
  { id: 'inbox', label: 'Para mí', to: { name: 'inbox' }, badge: decisions.value },
  { id: 'running', label: 'En curso', to: { name: 'running' } },
  { id: 'next', label: 'Próximo', to: { name: 'next' } },
  { id: 'assistant', label: 'Asistente', active: assistant.isOpen, dot: assistant.unread },
]);
function onTab(id: string) {
  if (id === 'assistant') assistant.open();
}

/** Las vistas, arriba en el menú lateral; lo que se consulta, debajo de una línea. */
const VIEWS = computed(() => [
  { to: { name: 'inbox' }, label: 'Para mí', count: decisions.value, hot: true },
  { to: { name: 'running' }, label: 'En curso', count: inbox.queue.pipeline.running + inbox.queue.pipeline.waiting },
  { to: { name: 'next' }, label: 'Próximo', count: inbox.queue.feed?.entries.length ?? 0 },
]);
const LOOKUP = [
  { to: { name: 'health' }, label: 'Estado del runner', hint: 'salud, capacidad, recursos' },
  { to: { name: 'improvements' }, label: 'Mejoras', hint: 'lo que dejó la retro' },
  { to: { name: 'webhooks' }, label: 'Webhooks', hint: 'qué llega de GitHub y Slack' },
  { to: { name: 'config' }, label: 'Config', hint: 'pipelines, agentes, providers' },
  { to: '/servers', label: 'Runners', hint: 'cambiar de runner' },
] as const;
</script>

<template>
  <div class="shell">
    <header class="bar">
      <RouterLink to="/servers" class="bar__runner" :title="`Cambiar de runner (${host})`">
        <span class="bar__name">
          <span class="bar__dot" :class="{ 'bar__dot--live': live }" aria-hidden="true" />
          <span class="bar__host">{{ host }}</span>
          <span class="bar__caret" aria-hidden="true">▾</span>
        </span>
        <span class="bar__status" data-test="runner-status">{{ status }}</span>
      </RouterLink>
      <span class="bar__gh">
        <button
          v-if="isMobile"
          type="button"
          class="bar__avatar"
          :aria-label="session.github ? `Más: tu cuenta (@${session.github.login}), Estado, Mejoras, Webhooks, Config` : 'Más: Estado, Mejoras, Webhooks, Config y entrar'"
          data-test="more"
          @click="moreOpen = true"
        >
          <span>{{ initials || '··' }}</span>
        </button>
        <template v-else-if="session.github">
          <span class="mono bar__login">@{{ session.github.login }}</span>
          <button type="button" class="btn btn--ghost" @click="session.logout()">Salir</button>
        </template>
        <button v-else type="button" class="btn" @click="session.requestLogin()">Entrar con GitHub</button>
      </span>
    </header>

    <div class="body">
      <nav v-if="!isMobile" class="side" aria-label="Secciones">
        <RouterLink v-for="v in VIEWS" :key="v.label" :to="v.to" class="side__link">
          <span class="side__label">{{ v.label }}</span>
          <span v-if="v.count" class="side__count" :class="{ 'side__count--hot': v.hot }">{{ v.count }}</span>
        </RouterLink>
        <hr class="side__sep" />
        <RouterLink v-for="l in LOOKUP" :key="l.label" :to="l.to" class="side__link side__link--sub">
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
        <svg v-else-if="id === 'running'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>
        <svg v-else-if="id === 'next'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 6h14M5 12h14M5 18h9" /></svg>
        <span v-else class="tab-ai">✦</span>
      </template>
    </TabBar>

    <BottomSheet :open="moreOpen" title="Más" @close="moreOpen = false">
      <div class="more">
        <nav class="more__list" aria-label="Más pantallas">
          <RouterLink v-for="l in LOOKUP" :key="l.label" :to="l.to" class="more__link" @click="moreOpen = false">
            <span class="more__label">{{ l.label }}</span>
            <span class="more__hint">{{ l.hint }}</span>
          </RouterLink>
        </nav>
        <div class="more__account">
          <template v-if="session.github">
            <p class="more__who">Conectado como <span class="mono">@{{ session.github.login }}</span>. Lo que hagas sobre el board queda firmado con este usuario.</p>
            <button type="button" class="btn btn--danger" @click="logout">Salir de GitHub</button>
          </template>
          <button v-else type="button" class="btn btn--primary" @click="moreOpen = false; session.requestLogin()">Entrar con GitHub</button>
        </div>
      </div>
    </BottomSheet>

    <TaskDetailDrawer />
    <EpicDetailDrawer />
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; }

/* Una sola barra (R9): el runner y cómo está, y la cuenta. */
.bar {
  position: sticky;
  top: env(safe-area-inset-top, 0px);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: calc(var(--tap-h) + 0.5rem);
  padding: 0.2rem 0.5rem 0.2rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
/* `a:hover` global subraya: el runner es un bloque, no texto corrido. */
.bar__runner { display: flex; flex-direction: column; justify-content: center; flex: 1; min-width: 0; min-height: var(--tap-h); color: var(--fg); }
.bar__runner:hover { text-decoration: none; color: var(--fg); }
.bar__name { display: flex; align-items: center; gap: 0.4rem; min-width: 0; font-weight: 600; }
.bar__host { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar__dot { flex: none; width: 0.45rem; height: 0.45rem; border-radius: 50%; background: var(--fg-dimmer); }
.bar__dot--live { background: var(--live); box-shadow: 0 0 0 3px var(--green-bg); }
.bar__caret { flex: none; color: var(--fg-dim); font-size: var(--fs-micro); }
.bar__status { color: var(--fg-dim); font-size: var(--fs-chrome); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar__gh { display: flex; align-items: center; gap: 0.4rem; flex: none; font-size: var(--fs-body-sm); }
.bar__login { display: none; color: var(--fg-mute); }
.bar__avatar { display: grid; place-items: center; width: var(--tap-h); height: var(--tap-h); border: 0; background: none; cursor: pointer; }
.bar__avatar span { display: grid; place-items: center; width: 1.8rem; height: 1.8rem; border-radius: 50%; background: var(--panel-top); color: var(--fg); font: 600 var(--fs-chrome) var(--font-body); }
.tab-ai { color: var(--ai); font-size: 1.1rem; line-height: 1; }

/* El menú lateral es de desktop (en un teléfono, la tab bar y «Más»). */
.side {
  position: sticky;
  top: calc(env(safe-area-inset-top, 0px) + var(--tap-h) + 0.5rem);
  display: flex;
  flex-direction: column;
  gap: 2px;
  height: calc(100vh - var(--tap-h) - 0.5rem);
  padding: 0.5rem;
  border-right: 1px solid var(--border);
  background: var(--panel);
  overflow-y: auto;
}
.side__link { display: flex; align-items: center; gap: 0.5rem; min-height: var(--tap-h-sm); padding: 0.3rem 0.75rem; border-radius: var(--radius); color: var(--fg-mute); }
.side__link:hover { background: var(--panel-alt); color: var(--fg); text-decoration: none; }
.side__link--sub { flex-direction: column; align-items: flex-start; justify-content: center; gap: 0; }
.side__label { flex: 1; font-size: var(--fs-body); }
.side__hint { color: var(--fg-dim); font-size: var(--fs-chrome); }
.side__count { color: var(--fg-dim); font-size: var(--fs-chrome); font-variant-numeric: tabular-nums; }
.side__count--hot { min-width: 1.2rem; padding: 0 0.35rem; border-radius: 999px; background: var(--danger); color: var(--on-primary); font-weight: 600; text-align: center; }
.side__sep { width: auto; margin: 0.5rem 0.4rem; border: 0; border-top: 1px solid var(--border); }
/* Dónde estás: el fondo del segmento elegido, como el menú de Mac. */
.side__link.router-link-exact-active { background: var(--panel-hi); color: var(--fg); font-weight: 600; }

.more { display: flex; flex-direction: column; gap: 1rem; padding: 0 1rem; }
.more__list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel-alt); overflow: hidden; }
.more__link { display: flex; flex-direction: column; justify-content: center; min-height: calc(var(--tap-h) + 0.6rem); padding: 0.3rem 1rem; border-top: 1px solid var(--border-mute); color: var(--fg); }
.more__link:first-child { border-top: 0; }
.more__link:hover { text-decoration: none; background: var(--panel-hi); }
.more__hint { color: var(--fg-dim); font-size: var(--fs-chrome); }
.more__account { display: flex; flex-direction: column; gap: 0.6rem; }
.more__who { margin: 0; color: var(--fg-mute); }

/* El pie deja lugar a la tab bar fija (`--tap-h-lg` + su padding + la zona segura). */
.main { box-sizing: border-box; width: 100%; max-width: 72rem; margin: 0 auto; padding: 0.75rem 0.75rem calc(var(--tap-h-lg) + 1.5rem + env(safe-area-inset-bottom, 0px)); min-width: 0; }

@media (min-width: 768px) {
  .bar__login { display: inline; }
  .body { display: grid; grid-template-columns: 14rem minmax(0, 1fr); }
  .main { padding: 1rem 1.25rem 6rem; }
}
</style>
