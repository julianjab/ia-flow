<script setup lang="ts">
import { computed } from 'vue';
import type { DashboardView } from '@/features/inbox/view/decide';
import { useInboxStore } from '@/features/inbox/store';
import { useGithubSessionStore } from '@/stores/githubSession';

// Lo que el dashboard de este runner pone al lado de la bandeja: cuánto tiene el pipeline para
// correr, qué cards podría tomar ya y las líneas de higiene del board. Sólo muestra lo que el
// dashboard activó; ninguna es una decisión de una persona sobre una tarea.

const props = defineProps<{ view: DashboardView }>();

const store = useInboxStore();
const session = useGithubSessionStore();

const hygiene = computed(() => props.view.hygiene.filter((line) => line.count > 0));
const visible = computed(() => props.view.capacity || props.view.feed || hygiene.value.length > 0);

/** Mover una card al pipeline es una acción reversible con nombre propio: no pide confirmación
 *  aparte, pero sí el login de GitHub (queda firmada con tu usuario). */
async function start(ref: string, action: string) {
  if (!session.github) {
    session.requestLogin();
    return;
  }
  const token = await session.token();
  if (!token) {
    session.requestLogin();
    return;
  }
  await store.runAction(ref, action, token);
}
</script>

<template>
  <section v-if="visible" class="dp" aria-label="Pipeline">
    <div v-if="view.capacity" class="panel dp__box">
      <h2 class="uc-label">El pipeline</h2>
      <p class="dp__nums mono">
        <span>{{ view.capacity.running }} corriendo</span>
        <span>{{ view.capacity.waiting }} en cola</span>
        <span v-if="view.capacity.free !== undefined" class="dp__free">{{ view.capacity.free }} libres</span>
      </p>
    </div>

    <div v-if="view.feed" class="panel dp__box">
      <h2 class="uc-label">{{ view.feed.title }}</h2>
      <p v-if="view.feed.entries.length === 0" class="dp__none">Nada de lo que está esperando puede arrancar ya.</p>
      <ul v-else class="dp__list">
        <li v-for="entry in view.feed.entries" :key="entry.ref" class="dp__row">
          <a :href="entry.url" target="_blank" rel="noopener noreferrer" class="dp__title">{{ entry.title }} ↗</a>
          <span class="dp__ref mono">{{ entry.ref }}</span>
          <button
            v-if="entry.action"
            type="button"
            class="btn"
            :data-feed-action="entry.action.id"
            @click="start(entry.ref, entry.action.id)"
          >
            {{ entry.action.label }}
          </button>
        </li>
      </ul>
    </div>

    <div v-if="hygiene.length" class="panel dp__box">
      <h2 class="uc-label">Higiene del board</h2>
      <p v-for="line in hygiene" :key="line.text" class="dp__hy">{{ line.text }}</p>
    </div>
  </section>
</template>

<style scoped>
.dp { display: grid; gap: 0.75rem; }
/* 768 es el corte del shell: desde ahí, los paneles en columnas. */
@media (min-width: 768px) {
  .dp { grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); align-items: start; }
}
.dp__box { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.75rem; }
.dp__box h2 { margin: 0; }
.dp__nums { margin: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; color: var(--fg); font-size: var(--fs-body-sm); }
.dp__free { color: var(--accent); }
.dp__none, .dp__hy { margin: 0; color: var(--fg-mute); font-size: var(--fs-body-sm); }
.dp__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.dp__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.15rem 0.5rem; align-items: center; padding-top: 0.5rem; border-top: 1px solid var(--border-mute); }
.dp__row:first-child { padding-top: 0; border-top: 0; }
.dp__title { color: var(--fg); overflow-wrap: anywhere; }
.dp__title:hover { background: none; color: var(--accent); }
.dp__ref { grid-column: 1; color: var(--fg-dim); font-size: var(--fs-chrome); }
.dp__row .btn { grid-column: 2; grid-row: 1 / span 2; }
</style>
