<script setup lang="ts">
import type { InboxProject, RepoIssue } from '@ia-flow/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { formatRelative } from '@/composables/formatRelative';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import { tokenOrLogin } from '@/features/inbox/githubToken';
import { actionFailure, loadFailure } from '@/features/inbox/queue/advice';
import { defaultColumn } from '@/features/inbox/queue/columns';
import { shortRef } from '@/features/inbox/queue/shortRef';
import { useInboxStore } from '@/features/inbox/store';

// «En los repos, sin card»: los issues abiertos de cada repo del catálogo del runner que todavía no
// están en el board, por repo y el más reciente primero. Cada uno entra al board desde acá, en la
// columna que se elija (Todo por defecto), firmado con tu usuario. Un repo que no se pudo leer dice
// por qué en una línea, sin tapar al resto. Con un runner que no lo publica, no se dibuja.

const props = defineProps<{ projects: readonly InboxProject[] }>();
const store = useInboxStore();

onMounted(() => {
  if (!store.repoIssues && !store.repoIssuesLoading) void store.loadRepoIssues();
});
watch(
  () => store.project,
  () => void store.loadRepoIssues(),
);

const repos = computed(() => store.repoIssues?.repos ?? []);
const total = computed(() => repos.value.reduce((n, r) => n + r.items.length, 0));
const loadError = computed(() =>
  store.repoIssuesError ? loadFailure('leer los issues de los repos', store.repoIssuesError) : null,
);

const columnsOf = (projectId: string) => props.projects.find((p) => p.id === projectId)?.statuses ?? [];
/** La columna elegida por issue; sin elegir, la de entrada del board. */
const chosen = ref<Record<string, string>>({});
const columnFor = (issue: RepoIssue) => chosen.value[issue.ref] ?? defaultColumn(columnsOf(issue.project_id)) ?? '';
const pending = ref<string | null>(null);
const failures = ref<Record<string, string>>({});

async function add(issue: RepoIssue): Promise<void> {
  const token = await tokenOrLogin();
  if (!token) return;
  pending.value = issue.ref;
  const { [issue.ref]: _old, ...rest } = failures.value;
  failures.value = rest;
  const column = columnFor(issue);
  const out = await store.addToBoard(
    { issue: issue.ref, project_id: issue.project_id, ...(column ? { status: column } : {}) },
    token,
  );
  pending.value = null;
  const message = out.error ?? (out.result && !out.result.ok ? out.result.message : null);
  if (message) failures.value = { ...failures.value, [issue.ref]: message };
}
</script>

<template>
  <section v-if="store.repoIssues || loadError" class="ri" aria-labelledby="repo-issues-h" data-test="repo-issues">
    <div class="ri__head">
      <h2 id="repo-issues-h" class="ri__title">En los repos, sin card</h2>
      <span class="ri__count">{{ total }}</span>
    </div>
    <ActionError v-if="loadError" :failure="loadError" :busy="store.repoIssuesLoading" @retry="store.loadRepoIssues()" />
    <p v-else-if="!total && !repos.some((r) => r.error)" class="ri__empty">Todo lo abierto en los repos del runner ya está en el board.</p>

    <div v-for="repo in repos" :key="repo.repo" class="ri__repo">
      <h3 class="ri__repo-name mono">{{ repo.repo }} <span class="ri__n">{{ repo.items.length }}</span></h3>
      <p v-if="repo.error" class="ri__error" role="status">✕ {{ repo.error }}</p>
      <ul v-if="repo.items.length" class="ri__list">
        <li v-for="issue in repo.items" :key="issue.ref" class="ri__row" :data-ref="issue.ref">
          <span class="ri__what">
            <span class="ri__name">{{ issue.title }}</span>
            <span class="ri__meta">
              <RefLink :short="shortRef(issue.ref)" :url="issue.url" />
              · {{ formatRelative(issue.updated_at) }}<template v-if="issue.author"> · @{{ issue.author }}</template>
            </span>
          </span>
          <span class="ri__add">
            <select
              v-if="columnsOf(issue.project_id).length"
              class="ri__col"
              :aria-label="`Columna para ${shortRef(issue.ref)}`"
              :value="columnFor(issue)"
              @change="chosen = { ...chosen, [issue.ref]: ($event.target as HTMLSelectElement).value }"
            >
              <option v-for="c in columnsOf(issue.project_id)" :key="c" :value="c">{{ c }}</option>
            </select>
            <button type="button" class="btn" :disabled="pending === issue.ref" data-test="add-issue" @click="add(issue)">
              {{ pending === issue.ref ? '· agregando' : 'Agregar al board' }}
            </button>
          </span>
          <ActionError
            v-if="failures[issue.ref]"
            class="ri__fail"
            :failure="actionFailure('Agregar al board', failures[issue.ref] as string)"
            :busy="pending === issue.ref"
            @retry="add(issue)"
          />
        </li>
      </ul>
      <a v-if="repo.truncated" class="link ri__more" :href="`https://github.com/${repo.repo}/issues`" target="_blank" rel="noopener">
        Hay más en GitHub ↗
      </a>
    </div>
  </section>
</template>

<style scoped>
.ri { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
.ri__head { display: flex; align-items: baseline; gap: 0.5rem; }
.ri__title { margin: 0; font-size: var(--fs-body); }
.ri__count,
.ri__n { color: var(--fg-dim); font-size: var(--fs-chrome); font-weight: 400; }
.ri__empty { margin: 0; color: var(--fg-dim); }
.ri__repo { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel); overflow: hidden; }
.ri__repo-name { margin: 0; padding: 0.6rem 0.85rem; font-size: var(--fs-body-sm); font-weight: 600; color: var(--fg-mute); }
.ri__error { margin: 0; padding: 0 0.85rem 0.6rem; color: var(--danger); font-size: var(--fs-body-sm); }
.ri__list { list-style: none; margin: 0; padding: 0; }
.ri__row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.75rem; padding: 0.55rem 0.85rem; border-top: 1px solid var(--border-mute); }
.ri__what { flex: 1 1 14rem; display: flex; flex-direction: column; min-width: 0; }
.ri__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ri__meta { color: var(--fg-dim); font-size: var(--fs-chrome); }
.ri__add { display: flex; flex: none; gap: 0.4rem; }
.ri__col { min-height: var(--tap-h); }
.ri__fail { flex: 1 1 100%; }
.ri__more { display: inline-flex; align-items: center; min-height: var(--tap-h); padding: 0 0.85rem; }
</style>
