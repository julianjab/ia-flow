<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AddOutcome, AddRequest } from '@/features/github-search/board';
import GithubSearchPanel from '@/features/github-search/GithubSearchPanel.vue';
import { tokenOrLogin } from '@/features/inbox/githubToken';
import { useInboxStore } from '@/features/inbox/store';

// «Buscar en GitHub»: compone la búsqueda (features/github-search) con la bandeja (features/inbox),
// que no se conocen entre sí. La bandeja le dice qué está en el board y en qué columna, abre el
// detalle de una tarea DENTRO de la app (el drawer que monta el shell) y agrega un issue al board.

const store = useInboxStore();
const route = useRoute();
const router = useRouter();

const org = computed(() => store.projects[0]?.board.owner ?? null);
const boardRepos = computed(() => store.projects.flatMap((p) => p.repos ?? []));
const initialQuery = typeof route.query.q === 'string' ? route.query.q : '';

// Para saber en qué columna está lo que no está en la bandeja hace falta el resto del board.
onMounted(() => {
  if (!store.rest && !store.restLoading) void store.loadRest();
});

async function add(request: AddRequest): Promise<AddOutcome> {
  const token = await tokenOrLogin();
  if (!token) return { ok: false, message: 'Inicia sesión con GitHub para agregarlo.' };
  const out = await store.addToBoard(request, token);
  if (out.result?.ok) {
    void store.loadRest();
    return { ok: true, status: out.result.status ?? request.status ?? 'Todo' };
  }
  return { ok: false, message: out.error ?? out.result?.message ?? 'No se pudo agregar.' };
}

/** Lo escrito queda en la URL: volver atrás desde el detalle o recargar no lo pierde. */
function syncQuery(q: string): void {
  const next = q.trim();
  if ((route.query.q ?? '') === next) return;
  void router.replace({ query: next ? { q: next } : {} });
}
</script>

<template>
  <GithubSearchPanel
    :org="org"
    :board-repos="boardRepos"
    :board="store.boardIndex"
    :projects="store.projects"
    :add="add"
    :initial-query="initialQuery"
    @open="store.expand($event)"
    @query="syncQuery"
  />
</template>
