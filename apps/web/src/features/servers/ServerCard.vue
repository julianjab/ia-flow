<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ProbedServer } from '@/features/servers/api';

const props = defineProps<{
  server: ProbedServer;
  /** El server que esta web está mirando ahora. */
  current: boolean;
  /** Nombre para humanos, si el usuario le puso uno. */
  label?: string;
  /** El token guardado para este server. */
  token?: string;
  /** El login de GitHub guardado para este server. */
  github?: { login: string };
}>();

const emit = defineEmits<{
  (e: 'remove', baseUrl: string): void;
  (e: 'token', payload: { baseUrl: string; token: string }): void;
  (e: 'enter', baseUrl: string): void;
  (e: 'github-logout', baseUrl: string): void;
}>();

const port = computed(() => new URL(props.server.baseUrl).port || '80');
const isRunner = computed(() => props.server.kind === 'runner');

/**
 * El campo del token empieza abierto cuando el server contestó 401: en ese
 * estado es literalmente lo único que hay que hacer.
 */
const editing = ref(props.server.needsToken);
const draft = ref(props.token ?? '');

watch(
  () => props.server.needsToken,
  (needs) => {
    if (needs) editing.value = true;
  },
);
watch(
  () => props.token,
  (t) => {
    draft.value = t ?? '';
  },
);

/** Tres estados, no dos: vivo, pide token, y caído. */
const dotClass = computed(() => {
  if (props.server.reachable) return 'dot--up';
  return props.server.needsToken ? 'dot--auth' : 'dot--down';
});

function saveToken() {
  emit('token', { baseUrl: props.server.baseUrl, token: draft.value.trim() });
  editing.value = false;
}
</script>

<template>
  <article class="card" :class="{ 'card--current': current, 'card--down': !server.reachable }">
    <header class="card__hd">
      <span class="dot" :class="dotClass" />
      <span class="card__port">{{ label || `:${port}` }}</span>
      <span v-if="isRunner" class="tag">runner{{ server.version ? ` ${server.version}` : '' }}</span>
      <span v-if="current" class="tag tag--current">estás acá</span>
      <button
        v-if="!current"
        class="card__x"
        type="button"
        aria-label="Quitar de la lista"
        title="Quitar de la lista"
        @click.stop="emit('remove', server.baseUrl)"
      >
        ×
      </button>
    </header>

    <!-- El botón se estira sobre TODA la tarjeta con un `::after` absoluto: el
         área clickeable es la tarjeta entera, sigue siendo un botón de verdad
         (foco, Enter, lectores de pantalla), y el token y el × se apoyan por
         encima con un z-index. -->
    <button
      class="card__enter"
      type="button"
      :disabled="!server.reachable"
      :title="server.reachable ? `entrar a ${server.baseUrl}` : 'no responde'"
      @click="emit('enter', server.baseUrl)"
    >
      {{ server.baseUrl }}
    </button>

    <p v-if="server.needsToken" class="card__auth">· pide token</p>
    <p v-else-if="!server.reachable" class="card__empty">· no responde</p>
    <p v-else-if="!isRunner" class="card__auth">· no es un runner-v2: esta web no lo opera</p>

    <template v-else>
      <div class="card__stats">
        <span class="uc-label">proyectos</span>
        <span class="card__val">{{ server.projects.length }}</span>
        <span class="uc-label">latencia</span>
        <span class="card__val">{{ Math.round(server.latencyMs) }} ms</span>
      </div>

      <ul v-if="server.projects.length" class="card__projects">
        <li v-for="p in server.projects" :key="p.id">
          <span class="mono">{{ p.id }}</span>
          <span class="card__dim">{{ p.board.owner }}#{{ p.board.number }}</span>
        </li>
      </ul>
      <p v-else class="card__empty">· sin proyectos</p>

      <p class="card__gh">
        <template v-if="github">
          <span class="uc-label">github</span>
          <span class="mono">@{{ github.login }}</span>
          <button
            class="btn btn--ghost card__ghbtn"
            type="button"
            @click.stop="emit('github-logout', server.baseUrl)"
          >
            cerrar sesión
          </button>
        </template>
        <span v-else class="card__dim">· sin sesión de GitHub — se inicia desde la bandeja</span>
      </p>
    </template>

    <!-- Siempre disponible, no sólo ante un 401: así se puede pre-cargar el
         token de un server que todavía no levantaste. -->
    <div class="card__token" @click.stop>
      <form v-if="editing" class="card__tokenform" @submit.prevent="saveToken">
        <input
          v-model="draft"
          type="password"
          class="ff-field card__tokeninput"
          placeholder="token de la API"
          :aria-label="`token de ${server.baseUrl}`"
          autocomplete="off"
        />
        <button class="btn" type="submit">guardar</button>
      </form>
      <button v-else class="btn btn--ghost card__tokenlink" type="button" @click="editing = true">
        {{ token ? '· token configurado — cambiar' : '· sin token — configurar' }}
      </button>
    </div>
  </article>
</template>

<style scoped src="@/ui/form-fields.css" />
<style scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
}
.card:has(.card__enter:not(:disabled)):hover { border-color: var(--accent); }
.card:has(.card__enter:focus-visible) { outline: 1px solid var(--accent); outline-offset: 2px; }
.card--current { border-color: var(--accent); }
.card--down { opacity: 0.55; }

.card__hd { display: flex; align-items: center; gap: 0.5rem; }
.card__port { font-weight: 600; }
/* Un ✕ dentro de una fila no crece a 44px de caja: mide 24px visibles y expande
   su área con `::before` (blanco táctil sin costo de layout, DESIGN_SYSTEM). */
.card__x {
  position: relative;
  z-index: 1;
  margin-left: auto;
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: var(--fs-body);
  line-height: 1;
}
.card__x::before { content: ''; position: absolute; inset: -0.5rem; }
.card__x:hover { color: var(--danger); }

.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dot--up { background: var(--accent); }
.dot--down { background: var(--danger); }
.dot--auth { background: var(--warn); }

.card__auth { margin: 0; color: var(--warn); font-size: var(--fs-body-sm); }

.card__token { position: relative; z-index: 1; }
.card__tokenform { display: flex; gap: 0.3rem; }
.card__tokeninput { flex: 1; min-width: 0; }
.card__tokenlink { padding: 0; justify-content: flex-start; font-size: var(--fs-body-sm); }

/* Chip / tag: una sola caja (DESIGN_SYSTEM.md «Chip / tag»). */
.tag {
  line-height: var(--row-h);
  padding: 0 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.tag--current { margin-left: auto; color: var(--accent); border-color: var(--accent); }
.tag--current + .card__x { margin-left: 0.25rem; }

.card__enter::after { content: ''; position: absolute; inset: 0; }
.card__enter:disabled::after { display: none; }
.card__enter {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
  text-align: left;
  word-break: break-all;
  cursor: pointer;
}
.card__enter:hover:not(:disabled) { color: var(--accent); text-decoration: underline; }
.card__enter:disabled { cursor: default; }

.card__stats {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.15rem 0.6rem;
  align-items: baseline;
}
.card__val { font-variant-numeric: tabular-nums; }

.card__projects { list-style: none; margin: 0; padding: 0; font-size: var(--fs-body-sm); }
.card__projects li { display: flex; align-items: baseline; gap: 0.5rem; }
.card__dim { color: var(--fg-dim); font-size: var(--fs-body-sm); }
.card__empty { margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); }

.card__gh {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
}
.card__ghbtn { margin-left: auto; }
</style>
