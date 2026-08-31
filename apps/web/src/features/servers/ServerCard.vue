<script setup lang="ts">
import type { ProbedServer } from '@/features/servers/api';
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  server: ProbedServer;
  /** El server que esta web está mirando ahora. */
  current: boolean;
  /** Nombre para humanos, si el usuario le puso uno. */
  label?: string;
  /** El token guardado para este server. */
  token?: string;
}>();

const emit = defineEmits<{
  (e: 'remove', baseUrl: string): void;
  (e: 'token', payload: { baseUrl: string; token: string }): void;
  (e: 'enter', baseUrl: string): void;
}>();

const port = computed(() => new URL(props.server.baseUrl).port || '80');

const activeProjects = computed(
  () => props.server.projects.filter((p) => !p.settings?.pollingPaused).length,
);

const isAgentHost = computed(() => props.server.kind === 'agent-host');

/**
 * El cap de un agent-host, listo para leer.
 *
 * `null` es "sin cap", no cero — en todo el engine un cap ausente significa
 * "sin límite" (ver la sección de capacidad en CLAUDE.md), así que mostrar un
 * "0" ahí diría exactamente lo contrario de lo que pasa.
 */
const hostLoad = computed(() => {
  const h = props.server.agentHost;
  if (!h) return '';
  return h.maxConcurrentRuns ? `${h.running} / ${h.maxConcurrentRuns}` : `${h.running}`;
});

/**
 * El campo del token.
 *
 * Empieza abierto cuando el server contestó 401: en ese estado es literalmente
 * lo único que hay que hacer, y esconderlo detrás de un click sería esconder
 * el arreglo justo cuando hace falta.
 */
const editing = ref(props.server.needsToken);
const draft = ref(props.token ?? '');

// El sondeo puede llegar después de montar la tarjeta; si vuelve con 401,
// abrimos el campo igual.
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
      <!-- El tipo se muestra SIEMPRE que se conozca, incluso en un server que
           pide token: es la única pista de en qué pantalla está el arreglo, y
           es justo cuando el operador no puede averiguarlo por su cuenta. -->
      <span v-if="isAgentHost" class="tag tag--host">agent-host</span>
      <span v-if="current" class="tag tag--current">estás acá</span>
      <button
        v-if="!current"
        class="card__x"
        title="quitar de la lista"
        @click.stop="$emit('remove', server.baseUrl)"
      >
        ×
      </button>
    </header>

    <!-- El botón se estira sobre TODA la tarjeta con un `::after` absoluto, en
         vez de envolverla. Es la diferencia entre "la tarjeta es clickeable" y
         "la tarjeta es un botón": lo segundo, con `:disabled`, dejaba el campo
         del token inalcanzable justo en el server que lo pide — el navegador
         no despacha clicks a los descendientes de un botón deshabilitado.
         Así el área clickeable es la tarjeta entera, sigue siendo un botón de
         verdad (foco, Enter, lectores de pantalla), y el token y el × se
         apoyan por encima con un z-index. -->
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

    <!-- Un agent-host no tiene proyectos ni registraciones: tiene UN provider y
         una ocupación. Son los dos datos con los que se decide si mandarle
         trabajo, que es lo que esta tarjeta existe para contestar. -->
    <template v-else-if="isAgentHost">
      <div class="card__stats">
        <span class="uc-label">provider</span>
        <span class="card__val">{{ server.agentHost?.providerName || '—' }}</span>
        <span class="uc-label">en curso</span>
        <span class="card__val">{{ hostLoad }}</span>
        <span class="uc-label">latencia</span>
        <span class="card__val">{{ Math.round(server.latencyMs) }} ms</span>
      </div>

      <p v-if="server.agentHost && !server.agentHost.accepting" class="card__auth">
        · no está aceptando trabajo
      </p>
    </template>

    <template v-else>
      <div class="card__stats">
        <span class="uc-label">proyectos</span>
        <span class="card__val">
          {{ activeProjects }}<span class="card__val-sub"> / {{ server.projects.length }}</span>
        </span>
        <span class="uc-label">agent-hosts</span>
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

    <!-- Siempre disponible, no sólo ante un 401: así se puede pre-cargar el
         token de un server que todavía no levantaste. -->
    <div class="card__token" @click.stop>
      <form v-if="editing" class="card__tokenform" @submit.prevent="saveToken">
        <input
          v-model="draft"
          type="password"
          class="card__tokeninput"
          placeholder="token de la API"
          :aria-label="`token de ${server.baseUrl}`"
          autocomplete="off"
        />
        <button class="card__tokenbtn" type="submit">guardar</button>
      </form>
      <button v-else class="card__tokenlink" type="button" @click="editing = true">
        {{ token ? '· token configurado — cambiar' : '· sin token — configurar' }}
      </button>
    </div>
  </article>
</template>

<style scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--border);
  background: var(--bg-elev, transparent);
}
.card:has(.card__enter:not(:disabled)):hover { border-color: var(--accent); }
.card:has(.card__enter:focus-visible) { outline: 1px solid var(--accent); outline-offset: 2px; }
.card--current { border-color: var(--accent); }
.card--down { opacity: 0.55; }

.card__hd { display: flex; align-items: center; gap: 0.5rem; }
.card__port { font-weight: 600; }
.card__x {
  position: relative;
  z-index: 1;
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
.dot--auth { background: var(--warn, #d90); }

.card__auth { margin: 0; color: var(--warn, #d90); font-size: 0.8rem; }

.tag--host {
  border: 1px solid var(--border);
  padding: 0 0.3rem;
  color: var(--fg-dim);
  font-size: 0.7rem;
}

.card__token { margin-top: 0.1rem; position: relative; z-index: 1; }
.card__tokenform { display: flex; gap: 0.3rem; }
.card__tokeninput {
  flex: 1;
  min-width: 0;
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--border);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.8rem;
}
.card__tokenbtn, .card__tokenlink {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg-dim);
  font: inherit;
  font-size: 0.75rem;
  padding: 0.2rem 0.45rem;
  cursor: pointer;
}
.card__tokenlink { border: 0; padding: 0; text-align: left; }
.card__tokenbtn:hover, .card__tokenlink:hover { color: var(--accent); }

.tag {
  margin-left: auto;
  padding: 0 0.35rem;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tag--current { color: var(--accent); border: 1px solid var(--accent); }

.card__enter::after {
  /* Estira el área clickeable sobre la tarjeta entera. */
  content: '';
  position: absolute;
  inset: 0;
}
.card__enter:disabled::after { display: none; }

.card__enter {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--fg-dim);
  font-size: 0.8rem;
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
.card__val-sub { color: var(--fg-dim); }

.card__projects, .card__providers { list-style: none; margin: 0; padding: 0; font-size: 0.8rem; }
.card__projects li { display: flex; align-items: center; gap: 0.4rem; }
.card__providers li { color: var(--fg-dim); }
.card__pdot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex: none; }
.card__pdot--off { background: var(--fg-dim); }

.card__empty { margin: 0; color: var(--fg-dim); font-size: 0.8rem; }
</style>
