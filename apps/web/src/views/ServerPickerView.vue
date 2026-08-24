<script setup lang="ts">
import ServerCard from '@/features/servers/ServerCard.vue';
import { PROXIED_BASE_URL, currentBaseUrl, selectServer } from '@/features/servers/selection';
import { useServersStore } from '@/features/servers/store';
import { computed, onMounted, ref } from 'vue';

const store = useServersStore();
const newUrl = ref('');

const upCount = computed(() => store.reachable.length);

/**
 * Entrar a la app mirando ese server. Se guarda para la próxima visita, así
 * el paso por acá es de una sola vez y no un peaje en cada arranque.
 */
function enter(baseUrl: string) {
  selectServer(baseUrl === PROXIED_BASE_URL ? null : baseUrl);
  // Recarga completa a propósito: los stores de Pinia ya tienen datos del
  // server anterior cacheados y no hay un "reset all" — arrancar limpio es
  // más honesto que invalidar quince stores a mano.
  window.location.assign('/dashboard');
}

async function add() {
  const raw = newUrl.value;
  newUrl.value = '';
  await store.addUrl(raw);
}

onMounted(() => {
  void store.scan();
});
</script>

<template>
  <main class="picker">
    <header class="picker__hd">
      <h1 class="picker__title">ia-flow</h1>
      <p class="picker__sub">
        ¿Qué server querés ver? — {{ upCount }} respondiendo de {{ store.servers.length }} conocidos
      </p>
    </header>

    <section v-if="store.servers.length" class="grid">
      <button
        v-for="s in store.servers"
        :key="s.baseUrl"
        class="pick"
        :disabled="!s.reachable"
        @click="enter(s.baseUrl)"
      >
        <ServerCard
          :server="s"
          :current="s.baseUrl === currentBaseUrl()"
          :pinned="store.pinnedUrls.includes(s.baseUrl)"
          @remove="store.removeUrl"
        />
      </button>
    </section>

    <p v-else-if="store.scanning" class="empty">· buscando servers…</p>
    <p v-else class="empty">· ninguno respondió — levantá uno y volvé a buscar</p>

    <footer class="picker__ft">
      <button class="btn" :disabled="store.scanning" @click="store.scan()">
        {{ store.scanning ? 'sondeando…' : 'refrescar' }}
      </button>
      <button class="btn" :disabled="store.scanning" @click="store.sweepPorts()">
        buscar puertos
      </button>

      <form class="add" @submit.prevent="add">
        <input
          v-model="newUrl"
          class="add__input"
          placeholder="otro server — ej. localhost:3030"
          aria-label="URL del server"
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

/* El card entero es el botón de entrar; el botón no aporta chrome propio. */
.pick {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.pick:disabled { cursor: default; }
.pick:not(:disabled):hover :deep(.card) { border-color: var(--accent); }
.pick:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }

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
