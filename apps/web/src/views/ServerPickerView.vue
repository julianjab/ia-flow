<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ServerCard from '@/features/servers/ServerCard.vue';
import {
  chooseProxiedServer,
  currentBaseUrl,
  PROXIED_BASE_URL,
  selectServer,
} from '@/features/servers/selection';
import { useServersStore } from '@/features/servers/store';
import { useGithubSessionStore } from '@/stores/githubSession';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';

const store = useServersStore();
const session = useGithubSessionStore();
const newUrl = ref('');
const newToken = ref('');

/**
 * El server que se está por quitar. `null` = el diálogo está cerrado.
 *
 * Se confirma porque quitar un server se lleva su TOKEN y su login de GitHub, y
 * recuperarlos puede significar ir a buscarlos a otra máquina. El resto de la
 * pantalla es reversible tipeando; esto no.
 */
const pendingRemove = ref<string | null>(null);

const removeMessage = computed(() =>
  pendingRemove.value
    ? `Se quita ${pendingRemove.value} de la lista, junto con el token y el login de GitHub que tengas guardados para él. El server sigue corriendo — esto es sólo tu lista.`
    : '',
);

async function confirmRemove() {
  const url = pendingRemove.value;
  pendingRemove.value = null;
  if (url) await store.removeServer(url);
}

const upCount = computed(() => store.reachable.length);

/**
 * Entrar a la app mirando ese server. Se guarda para la próxima visita, así el
 * paso por acá es de una sola vez y no un peaje en cada arranque.
 */
function enter(baseUrl: string) {
  // `null` = "usá rutas relativas y que las proxee quien sirve esta página".
  // Eso vale SÓLO con el dev server de Vite, que tiene el proxy configurado.
  // La app de escritorio sirve la SPA desde un static server que no proxea
  // nada: ahí una ruta relativa a `/api/...` cae en el fallback de la SPA y
  // devuelve index.html con 200, así que axios parsea HTML como JSON y la app
  // entera se rompe en silencio. Con el puente presente, siempre absoluta.
  const proxied = baseUrl === PROXIED_BASE_URL && !('iaFlowDesktop' in globalThis);
  const kind = store.servers.find((s) => s.baseUrl === baseUrl)?.kind ?? 'runner';
  selectServer(
    proxied ? null : baseUrl,
    store.tokenFor(baseUrl),
    kind,
    store.githubFor(baseUrl) ?? null,
  );
  if (proxied) chooseProxiedServer();
  // Recarga completa a propósito: los stores de Pinia ya tienen datos del
  // server anterior cacheados y no hay un "reset all" — arrancar limpio es más
  // honesto que invalidar cada store a mano.
  window.location.assign('/');
}

/** Cerrar sesión de GitHub en UN server de la lista (no sólo en el elegido). */
async function githubLogout(baseUrl: string) {
  await store.updateServer(baseUrl, { github: undefined });
  if (currentBaseUrl() === baseUrl) await session.logout();
}

async function add() {
  const raw = newUrl.value;
  const token = newToken.value.trim();
  newUrl.value = '';
  newToken.value = '';
  await store.addServer(raw, token || undefined);
}

onMounted(() => {
  void store.init();
});
</script>

<template>
  <main class="picker">
    <header class="picker__hd">
      <h1 class="picker__title">ia-flow</h1>
      <p class="picker__sub">
        ¿Qué runner querés ver? — {{ upCount }} respondiendo de
        {{ store.servers.length }} configurados.
      </p>
    </header>

    <section v-if="store.servers.length" class="grid">
      <ServerCard
        v-for="s in store.servers"
        :key="s.baseUrl"
        :server="s"
        :current="s.baseUrl === currentBaseUrl()"
        :token="store.tokenFor(s.baseUrl)"
        :github="store.githubFor(s.baseUrl)"
        @github-logout="githubLogout"
        @enter="enter"
        @remove="pendingRemove = $event"
        @token="store.updateServer($event.baseUrl, { token: $event.token })"
      />
    </section>

    <p v-else-if="!store.loaded || store.scanning" class="empty">· cargando…</p>
    <p v-else class="empty">
      · todavía no agregaste nada — pegá abajo la URL de un runner
    </p>

    <ConfirmDialog
      :open="pendingRemove !== null"
      title="Quitar server"
      :message="removeMessage"
      confirm-label="Quitar"
      danger
      @confirm="confirmRemove"
      @cancel="pendingRemove = null"
    />

    <footer class="picker__ft">
      <button class="btn" :disabled="store.scanning" @click="store.scan()">
        {{ store.scanning ? 'sondeando…' : 'refrescar' }}
      </button>
      <form class="add" @submit.prevent="add">
        <input
          v-model="newUrl"
          class="ff-field add__input"
          placeholder="URL — ej. localhost:3001"
          aria-label="URL del runner"
        />
        <input
          v-model="newToken"
          type="password"
          class="ff-field add__input add__input--token"
          placeholder="token (si lo pide)"
          aria-label="token de la API"
          autocomplete="off"
        />
        <button class="btn btn--primary" type="submit" :disabled="!newUrl.trim()">agregar</button>
      </form>
    </footer>
  </main>
</template>

<style scoped src="@/ui/form-fields.css" />
<style scoped>
.picker {
  max-width: 62rem;
  margin: 0 auto;
  padding: 2rem 1rem 3rem;
}

.picker__hd { margin-bottom: 1.5rem; }
.picker__title { margin: 0; }
.picker__sub { margin: 0.35rem 0 0; color: var(--fg-dim); font-size: var(--fs-body-sm); }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(17rem, 100%), 1fr));
  gap: 0.8rem;
}

.picker__ft {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
  margin-top: 2rem;
  padding-top: 1.2rem;
  border-top: 1px solid var(--border);
}

/* R2: nada de scroll horizontal — los campos ceden y la fila envuelve. */
.add { display: flex; flex-wrap: wrap; gap: 0.4rem; flex: 1 1 24rem; }
.add__input { flex: 1 1 12rem; min-width: 0; }
.add__input--token { flex-basis: 9rem; }

.empty { color: var(--fg-dim); font-size: var(--fs-body-sm); }

@media (min-width: 768px) {
  .picker { padding: 4rem 1.5rem 3rem; }
}
</style>
