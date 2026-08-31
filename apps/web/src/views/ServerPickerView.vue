<script setup lang="ts">
import ServerCard from '@/features/servers/ServerCard.vue';
import type { ProbedServer } from '@/features/servers/api';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import { PROXIED_BASE_URL, currentBaseUrl, selectServer } from '@/features/servers/selection';
import { useServersStore } from '@/features/servers/store';
import { computed, onMounted, ref } from 'vue';

const store = useServersStore();
const newUrl = ref('');
const newToken = ref('');

/**
 * El server que se está por quitar. `null` = el diálogo está cerrado.
 *
 * Se confirma porque quitar un server se lleva su TOKEN, y recuperarlo puede
 * significar ir a buscarlo a otra máquina. El resto de la pantalla es
 * reversible tipeando; esto no.
 */
const pendingRemove = ref<string | null>(null);

const removeMessage = computed(() =>
  pendingRemove.value
    ? `Se quita ${pendingRemove.value} de la lista, junto con el token que tengas guardado para él. El server sigue corriendo — esto es sólo tu lista.`
    : '',
);

async function confirmRemove() {
  const url = pendingRemove.value;
  pendingRemove.value = null;
  if (url) await store.removeServer(url);
}

const upCount = computed(() => store.reachable.length);

/**
 * Entrar a la app mirando ese server. Se guarda para la próxima visita, así
 * el paso por acá es de una sola vez y no un peaje en cada arranque.
 */
/**
 * A dónde entra cada tipo. Es lo único que la elección de server decide más
 * allá de la baseUrl, y vive acá y no en el router porque el router no sabe
 * (todavía) qué elegiste — la elección se aplica y recién después se navega.
 */
const HOME: Record<ProbedServer['kind'], string> = {
  server: '/dashboard',
  'agent-host': '/agent-host',
  unknown: '/dashboard',
};

function enter(baseUrl: string) {
  // `null` = "usá rutas relativas y que las proxee quien sirve esta página".
  // Eso vale SÓLO con el dev server de Vite, que tiene el proxy configurado.
  // La app de escritorio sirve la SPA desde un static server que no proxea
  // nada: ahí una ruta relativa a `/api/...` cae en el fallback de la SPA y
  // devuelve index.html con 200, así que axios parsea HTML como JSON y la app
  // entera se rompe en silencio. Con el puente presente, siempre absoluta.
  const proxied = baseUrl === PROXIED_BASE_URL && !('iaFlowDesktop' in globalThis);
  const kind = store.servers.find((s) => s.baseUrl === baseUrl)?.kind ?? 'server';
  selectServer(proxied ? null : baseUrl, store.tokenFor(baseUrl), kind);
  // Recarga completa a propósito: los stores de Pinia ya tienen datos del
  // server anterior cacheados y no hay un "reset all" — arrancar limpio es
  // más honesto que invalidar quince stores a mano. Con dos tipos de proceso
  // además es obligatorio: el shell elige su navegación una sola vez, al
  // montar, y pasar de un server a un agent-host sin recargar dejaría el menú
  // del anterior.
  window.location.assign(HOME[kind]);
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
        ¿Qué server querés ver? — {{ upCount }} respondiendo de
        {{ store.servers.length }} configurados. Van los dos procesos: un server
        (o runner) y un agent-host.
      </p>
    </header>

    <section v-if="store.servers.length" class="grid">
      <ServerCard
        v-for="s in store.servers"
        :key="s.baseUrl"
        :server="s"
        :current="s.baseUrl === currentBaseUrl()"
        :token="store.tokenFor(s.baseUrl)"
        @enter="enter"
        @remove="pendingRemove = $event"
        @token="store.updateServer($event.baseUrl, { token: $event.token })"
      />
    </section>

    <p v-else-if="!store.loaded || store.scanning" class="empty">· cargando…</p>
    <p v-else class="empty">
      · todavía no agregaste nada — pegá abajo la URL de un server o de un
      agent-host
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
          class="add__input"
          placeholder="URL — ej. localhost:3001 o un agent-host en :3012"
          aria-label="URL del server"
        />
        <input
          v-model="newToken"
          type="password"
          class="add__input add__input--token"
          placeholder="token (si lo pide)"
          aria-label="token de la API"
          autocomplete="off"
        />
        <button class="btn" type="submit" :disabled="!newUrl.trim()">agregar</button>
      </form>
    </footer>
  </main>
</template>

<style scoped>
.picker {
  max-width: 62rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 3rem;
}

.picker__hd { margin-bottom: 2rem; }
.picker__title { margin: 0; font-size: 1.5rem; font-weight: 600; letter-spacing: 0.02em; }
.picker__sub { margin: 0.35rem 0 0; color: var(--fg-dim); font-size: 0.9rem; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
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

.add { display: flex; gap: 0.4rem; }
.add__input {
  min-width: 15rem;
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border);
  background: transparent;
  color: inherit;
  font: inherit;
}

.add__input--token { min-width: 10rem; }

.btn {
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--border);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn:disabled { opacity: 0.5; cursor: default; }

.empty { color: var(--fg-dim); }
</style>
