<script setup lang="ts">
import type { PullRequestRef } from '@ia-flow/shared';

// Fila de etiquetas de una tarea: repos, rama remota y PRs. Vive en components/
// porque la comparten el listado (TareasSection) y el detalle (ItemReposModal);
// los tipos cruzan el wire, así que vienen de @ia-flow/shared, no de una feature.
const props = withDefaults(
  defineProps<{
    repos?: string[];
    branch?: string;
    branchUrl?: string;
    pullRequests?: PullRequestRef[];
    /** El provider modela ramas/PRs. False (local-fs) ⇒ no decimos nada de ellos. */
    devLinks?: boolean;
    /** false ⇒ NO sabemos si hay PRs (selección degradada). Un "no sé" no se
     * dibuja como "no hay". */
    pullRequestsKnown?: boolean;
    /** Marcar la ausencia de repos. El detalle no lo necesita: ya es el editor. */
    showEmptyRepos?: boolean;
  }>(),
  { pullRequestsKnown: true },
);

const PR_STATE_LABEL: Record<PullRequestRef['state'], string> = {
  open: 'abierto',
  merged: 'mergeado',
  closed: 'cerrado',
};

function prLabel(pr: PullRequestRef): string {
  return `PR #${pr.number} · ${pr.isDraft ? 'draft' : PR_STATE_LABEL[pr.state]}`;
}

function prClass(pr: PullRequestRef): string {
  return `is-pr-${pr.isDraft ? 'draft' : pr.state}`;
}
</script>

<template>
  <div class="task-tags-row">
    <span v-for="r in props.repos ?? []" :key="r" class="task-repo-chip">{{ r }}</span>
    <span v-if="showEmptyRepos && !(props.repos ?? []).length" class="task-dev-empty">Sin repos</span>

    <a
      v-if="branch && branchUrl"
      class="task-dev-chip is-branch"
      :href="branchUrl"
      target="_blank"
      rel="noopener"
      :title="`Rama remota: ${branch}`"
      @click.stop
    >⎇ {{ branch }}</a>
    <span v-else-if="branch" class="task-dev-chip is-branch" :title="branch">⎇ {{ branch }}</span>
    <span v-else-if="devLinks" class="task-dev-empty">Sin rama remota</span>

    <a
      v-for="pr in props.pullRequests ?? []"
      :key="pr.url"
      class="task-dev-chip"
      :class="prClass(pr)"
      :href="pr.url"
      target="_blank"
      rel="noopener"
      :title="pr.title ?? prLabel(pr)"
      @click.stop
    >{{ prLabel(pr) }}</a>
    <span
      v-if="devLinks && pullRequestsKnown && !(props.pullRequests ?? []).length"
      class="task-dev-empty"
    >Sin PR</span>
  </div>
</template>

<style scoped>
.task-tags-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; }
.task-repo-chip {
  font-size: 0.72rem;
  padding: 0.1rem 0.45rem;
  background: var(--panel-hi);
  color: var(--info);
  font-family: var(--font-mono);
}
.task-dev-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  padding: 0.1rem 0.45rem;
  border: 1px solid var(--border-hi);
  background: var(--panel-hi);
  color: var(--fg-mute);
  text-decoration: none;
  max-width: 34ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-dev-chip:hover { border-color: var(--fg-dim); color: var(--fg); }
.task-dev-chip.is-branch { color: var(--info); border-color: var(--info); }
.task-dev-chip.is-pr-open { color: var(--accent); border-color: var(--accent); }
.task-dev-chip.is-pr-merged { color: var(--ai); border-color: var(--ai); }
.task-dev-chip.is-pr-closed { color: var(--danger); border-color: var(--danger); }
.task-dev-chip.is-pr-draft { color: var(--fg-dim); border-color: var(--border-hi); }
.task-dev-empty { font-size: 0.72rem; color: var(--fg-dimmer); font-style: italic; }
</style>
