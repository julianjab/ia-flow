<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { GithubSearchApi } from '@/features/github-search/api';
import {
  type AddOutcome,
  type AddRequest,
  type BoardEntry,
  type BoardProject,
  boardEntryOf,
} from '@/features/github-search/board';
import GithubResultRow from '@/features/github-search/GithubResultRow.vue';
import { boardRepoNames, githubWebUrl } from '@/features/github-search/query';
import RepoPicker from '@/features/github-search/RepoPicker.vue';
import { useGithubSearch } from '@/features/github-search/useGithubSearch';
import { useGithubSessionStore } from '@/stores/githubSession';

// «Buscar en GitHub» (paridad con el menú de Mac): issues y PRs de cualquier repo de la
// organización, estén o no en el board. Busca con tu login de GitHub, directo contra api.github.com.
// Nada de acá saca de ia-flow: lo que está en el board se abre en su detalle (lo hace la view, con
// `open`); lo que no, se agrega desde la fila. Sólo el ↗ abre GitHub, en otra pestaña.

const props = defineProps<{
  /** La organización (el owner de los boards); `null` mientras carga la bandeja. */
  org: string | null;
  /** El catálogo de repos de los proyectos (`owner/repo`): van primero en el selector. */
  boardRepos: readonly string[];
  /** Qué está en el board, por ref (o PR) en minúsculas. */
  board: ReadonlyMap<string, BoardEntry>;
  projects: readonly BoardProject[];
  add: (request: AddRequest) => Promise<AddOutcome>;
  /** Lo que ya se escribió (el buscador de la bandeja lo manda por la URL). */
  initialQuery?: string;
  /** Para los tests: GitHub sin red. */
  api?: (token: string) => GithubSearchApi;
  delay?: number;
}>();
const emit = defineEmits<{ open: [ref: string]; query: [q: string] }>();

const session = useGithubSessionStore();
const gh = useGithubSearch({
  org: () => props.org,
  token: () => session.token(),
  ...(props.api ? { api: props.api } : {}),
  ...(props.delay !== undefined ? { delay: props.delay } : {}),
  boardRepos: () => (props.org ? boardRepoNames(props.boardRepos, props.org) : []),
});
const picking = ref(false);
/** Los que se agregaron desde acá (ref en minúsculas → columna): la fila lo dice sin esperar al board. */
const added = ref<Record<string, string>>({});

const boardNames = computed(() => (props.org ? boardRepoNames(props.boardRepos, props.org) : []));
const placeholder = computed(() =>
  gh.repo.value ? `Número o texto en ${gh.repo.value}` : 'Texto, repo#número o link de GitHub',
);
const webUrl = computed(() =>
  props.org ? githubWebUrl(gh.query.value, { org: props.org, repo: gh.repo.value }) : null,
);
const showLogin = computed(() => gh.needsLogin.value || !session.github);

onMounted(() => {
  if (props.initialQuery) gh.query.value = props.initialQuery;
  void gh.loadRepos();
});
watch(
  () => session.github?.login,
  () => gh.sessionChanged(),
);
watch(gh.query, (q) => emit('query', q));

function select(name: string | null): void {
  gh.select(name);
  picking.value = false;
}
</script>

<template>
  <section class="gs" aria-labelledby="gs-h">
    <header class="gs__head">
      <div class="gs__titles">
        <h1 id="gs-h" class="gs__title">Buscar en GitHub</h1>
        <p v-if="org" class="gs__sub">Cualquier repo de {{ org }}<template v-if="gh.searching.value"> · buscando…</template></p>
      </div>
      <a
        v-if="webUrl"
        class="gs__web link"
        :href="webUrl"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Abrir esta búsqueda en GitHub"
        data-test="web"
        >↗</a
      >
    </header>

    <p v-if="!org" class="gs__note">Cargando los proyectos del runner…</p>
    <template v-else>
      <div class="gs__bar">
        <button
          type="button"
          class="gs__scope"
          :aria-expanded="picking"
          aria-label="Elegir el repo donde buscar"
          data-test="scope"
          @click="picking = !picking"
        >
          <span class="gs__scope-name" :class="{ mono: gh.repo.value }">{{ gh.repo.value ?? `Toda ${org}` }}</span> ▾
        </button>
        <input
          v-model="gh.query.value"
          class="gs__input"
          type="search"
          :placeholder="placeholder"
          aria-label="Buscar en GitHub"
          data-test="query"
          @keydown.escape="gh.query.value = ''"
        />
      </div>
      <p class="gs__hint">
        Usa tu login de GitHub (sólo lectura). Un número se busca en los repos del board y los más activos; con un repo elegido, va directo.
      </p>

      <RepoPicker
        v-if="picking"
        :org="org"
        :board="boardNames"
        :repos="gh.repos.value"
        :selected="gh.repo.value"
        :loading="gh.loadingRepos.value"
        @select="select"
      />

      <div v-if="showLogin" class="gs__login" data-test="login">
        <span>La búsqueda en GitHub usa tu login (sólo lectura).</span>
        <button type="button" class="btn btn--primary" @click="session.requestLogin()">Iniciar sesión con GitHub</button>
      </div>

      <ul v-if="gh.results.value.length" class="gs__list" data-test="results">
        <GithubResultRow
          v-for="issue in gh.results.value"
          :key="issue.ref"
          :issue="issue"
          :entry="boardEntryOf(board, issue.ref)"
          :added="added[issue.ref.toLowerCase()] ?? null"
          :projects="projects"
          :add="add"
          @open="emit('open', $event)"
          @added="added = { ...added, [issue.ref.toLowerCase()]: $event }"
        />
      </ul>
      <p v-if="gh.note.value" class="gs__note" role="status" data-test="note">{{ gh.note.value }}</p>
      <p v-else-if="!gh.query.value.trim() && !picking" class="gs__note">
        <template v-if="gh.repo.value">El número de un issue o PR de {{ gh.repo.value }}, o texto del título.</template>
        <template v-else>Texto del título en toda {{ org }}, un número, <span class="mono">repo#1881</span>, o el link de un issue o PR.</template>
      </p>
    </template>
  </section>
</template>

<style scoped>
.gs { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
.gs__head { display: flex; align-items: flex-start; gap: 0.5rem; }
.gs__titles { flex: 1; min-width: 0; }
.gs__title { margin: 0; font-size: var(--fs-display); }
.gs__sub { margin: 0; color: var(--fg-dim); font-size: var(--fs-chrome); }
.gs__web { display: grid; place-items: center; flex: none; width: var(--tap-h); height: var(--tap-h); }
.gs__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.gs__scope {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  max-width: 100%;
  min-height: var(--tap-h);
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-alt);
  color: var(--fg-mute);
  font: inherit;
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.gs__scope:hover { color: var(--fg); border-color: var(--border-hi); }
.gs__scope:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.gs__scope-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gs__input { flex: 1 1 14rem; min-width: 0; min-height: var(--tap-h); font-size: var(--fs-input); }
.gs__hint { margin: 0; color: var(--fg-dim); font-size: var(--fs-chrome); }
.gs__login {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--fg-mute);
}
.gs__login .btn { min-height: var(--tap-h); }
.gs__list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.gs__note { margin: 0; color: var(--fg-mute); font-size: var(--fs-body-sm); }
</style>
