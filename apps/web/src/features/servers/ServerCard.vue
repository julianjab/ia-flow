<script setup lang="ts">
import type { ProbedServer } from '@/features/servers/api';
import { computed } from 'vue';

const props = defineProps<{
  server: ProbedServer;
  /** El server que esta web está proxeando — el que ya estás mirando. */
  current: boolean;
  /** Agregado a mano por el usuario (se puede quitar; los del barrido no). */
  pinned: boolean;
}>();

defineEmits<{ (e: 'remove', baseUrl: string): void }>();

const port = computed(() => new URL(props.server.baseUrl).port || '80');

const activeProjects = computed(
  () => props.server.projects.filter((p) => !p.settings?.pollingPaused).length,
);
</script>

<template>
  <article class="card" :class="{ 'card--current': current, 'card--down': !server.reachable }">
    <header class="card__hd">
      <span class="dot" :class="server.reachable ? 'dot--up' : 'dot--down'" />
      <span class="card__port">:{{ port }}</span>
      <span v-if="current" class="tag tag--current">estás acá</span>
      <button
        v-if="pinned && !current"
        class="card__x"
        title="quitar de la lista"
        @click="$emit('remove', server.baseUrl)"
      >
        ×
      </button>
    </header>

    <a class="card__url" :href="server.baseUrl" target="_blank" rel="noopener">
      {{ server.baseUrl }}
    </a>

    <p v-if="!server.reachable" class="card__empty">· no responde</p>

    <template v-else>
      <div class="card__stats">
        <span class="uc-label">proyectos</span>
        <span class="card__val">
          {{ activeProjects }}<span class="card__val-sub"> / {{ server.projects.length }}</span>
        </span>
        <span class="uc-label">gateways</span>
        <span class="card__val">{{ server.remoteProviders.length }}</span>
        <span class="uc-label">latencia</span>
        <span class="card__val">{{ Math.round(server.latencyMs) }} ms</span>
      </div>

      <ul v-if="server.projects.length" class="card__projects">
        <li v-for="p in server.projects" :key="p.id">
          <span class="card__pdot" :class="{ 'card__pdot--off': p.settings?.pollingPaused }" />
          {{ p.name || p.id }}
        </li>
      </ul>
      <p v-else class="card__empty">· sin proyectos</p>

      <ul v-if="server.remoteProviders.length" class="card__providers">
        <li v-for="r in server.remoteProviders" :key="r.id">remote:{{ r.id }}</li>
      </ul>
    </template>
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--border);
  background: var(--bg-elev, transparent);
}
.card--current { border-color: var(--accent); }
.card--down { opacity: 0.55; }

.card__hd { display: flex; align-items: center; gap: 0.5rem; }
.card__port { font-weight: 600; }
.card__x {
  margin-left: auto;
  border: 0;
  background: none;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
}
.card__x:hover { color: var(--danger); }

.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dot--up { background: var(--accent); }
.dot--down { background: var(--danger); }

.tag {
  margin-left: auto;
  padding: 0 0.35rem;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tag--current { color: var(--accent); border: 1px solid var(--accent); }

.card__url { color: var(--fg-dim); font-size: 0.8rem; text-decoration: none; word-break: break-all; }
.card__url:hover { color: var(--accent); text-decoration: underline; }

.card__stats {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.15rem 0.6rem;
  align-items: baseline;
}
.card__val { font-variant-numeric: tabular-nums; }
.card__val-sub { color: var(--fg-dim); }

.card__projects, .card__providers { list-style: none; margin: 0; padding: 0; font-size: 0.8rem; }
.card__projects li { display: flex; align-items: center; gap: 0.4rem; }
.card__providers li { color: var(--fg-dim); }
.card__pdot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex: none; }
.card__pdot--off { background: var(--fg-dim); }

.card__empty { margin: 0; color: var(--fg-dim); font-size: 0.8rem; }
</style>
