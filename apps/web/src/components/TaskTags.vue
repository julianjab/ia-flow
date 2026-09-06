<script setup lang="ts">
import type { PullRequestRef } from '@ia-flow/shared';

// Fila de etiquetas de una tarea: repos, rama remota y PRs. Vive en components/
// porque la comparten el listado (TareasSection) y el detalle (TaskDetailModal);
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
    /** Hilo de Slack donde se pidió review de esta tarea. Lo resuelve el
     *  source (cada uno lo guarda donde puede), así que acá llega ya listo. */
    slackThreadUrl?: string;
  }>(),
  { pullRequestsKnown: true },
);

// Glifo + palabra por estado, como el resto de la consola (ver DESIGN_SYSTEM).
// El glifo carga el color; la palabra queda en dim para que el número del PR
// siga siendo lo primero que se lee.
const PR_STATE = {
  open: { glyph: '●', label: 'abierto' },
  merged: { glyph: '✓', label: 'mergeado' },
  closed: { glyph: '✕', label: 'cerrado' },
  draft: { glyph: '○', label: 'draft' },
} as const;

type PrState = keyof typeof PR_STATE;

function prState(pr: PullRequestRef): PrState {
  return pr.isDraft ? 'draft' : pr.state;
}

// El CI es un segundo eje sobre el mismo chip: su glifo va después del estado
// del PR, no en un chip aparte — un PR abierto con CI rojo es UN hecho, no dos.
// `ci` ausente = el PR no tiene checks; no se dibuja nada (decir "sin CI" en
// cada repo sin pipeline sería ruido, no ausencia significativa).
const CI_STATE = {
  success: { glyph: '✓', label: 'CI ok' },
  failure: { glyph: '✕', label: 'CI falló' },
  error: { glyph: '✕', label: 'CI con error' },
  pending: { glyph: '◐', label: 'CI corriendo' },
  expected: { glyph: '◐', label: 'CI pendiente' },
} as const;

function prTitle(pr: PullRequestRef): string {
  const state = PR_STATE[prState(pr)].label;
  const ci = pr.ci ? ` · ${CI_STATE[pr.ci].label}` : '';
  return pr.title
    ? `${pr.title} — PR #${pr.number} (${state})${ci}`
    : `PR #${pr.number} (${state})${ci}`;
}
</script>

<template>
  <div class="task-tags-row">
    <span v-for="r in props.repos ?? []" :key="r" class="tag tag--repo">{{ r }}</span>
    <span v-if="showEmptyRepos && !(props.repos ?? []).length" class="tag-empty">sin repos</span>

    <component
      :is="branch && branchUrl ? 'a' : 'span'"
      v-if="branch"
      class="tag tag--branch"
      :href="branchUrl"
      :target="branchUrl ? '_blank' : undefined"
      :rel="branchUrl ? 'noopener' : undefined"
      :title="`Rama remota: ${branch}`"
      @click.stop
    >
      <span class="tag__glyph">⎇</span>
      <span class="tag__text">{{ branch }}</span>
    </component>
    <span v-else-if="devLinks" class="tag-empty">sin rama</span>

    <a
      v-for="pr in props.pullRequests ?? []"
      :key="pr.url"
      class="tag tag--pr"
      :class="`is-${prState(pr)}`"
      :href="pr.url"
      target="_blank"
      rel="noopener"
      :title="prTitle(pr)"
      @click.stop
    >
      <span class="tag__glyph">{{ PR_STATE[prState(pr)].glyph }}</span>
      <span class="tag__text">PR #{{ pr.number }}</span>
      <span class="tag__meta">{{ PR_STATE[prState(pr)].label }}</span>
      <span v-if="pr.ci" class="tag__ci" :class="`is-ci-${pr.ci}`">{{ CI_STATE[pr.ci].glyph }}</span>
    </a>
    <span
      v-if="devLinks && pullRequestsKnown && !(props.pullRequests ?? []).length"
      class="tag-empty"
    >sin PR</span>

    <a
      v-if="slackThreadUrl"
      class="tag tag--slack"
      :href="slackThreadUrl"
      target="_blank"
      rel="noopener"
      title="Hilo de review en Slack"
      @click.stop
    >
      <span class="tag__glyph">✦</span>
      <span class="tag__text">slack</span>
    </a>
  </div>
</template>

<style scoped>
.task-tags-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}

/* Una sola caja para los tres tipos de tag: misma altura (--row-h), misma
   tipografía mono, mismo radio. Sólo cambia el color del borde/glifo. */
.tag {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
  max-width: min(38ch, 100%);
  min-width: 0;
  padding: 0 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-hi);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  text-decoration: none;
  white-space: nowrap;
}
/* `theme.css` define `a:hover { background: var(--accent) }` para links de
   texto. Un tag no lo es: sin redefinir el fondo acá, cada chip se pintaba
   entero de teal al pasar el mouse. */
a.tag:hover {
  background: var(--panel-alt);
  border-color: var(--border-hi);
  color: var(--fg);
}

/* El texto es lo único que trunca: el glifo y el estado quedan siempre
   legibles, así una rama larga no se come su propia etiqueta. */
.tag__text { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.tag__glyph { flex: 0 0 auto; font-size: 0.9em; }
.tag__meta { flex: 0 0 auto; color: var(--fg-dim); }

.tag--repo { color: var(--info); }
.tag--branch { color: var(--fg-mute); }
.tag--branch .tag__glyph { color: var(--info); }
.tag--pr.is-open .tag__glyph { color: var(--accent); }
.tag--pr.is-merged .tag__glyph { color: var(--ai); }
.tag--pr.is-closed .tag__glyph { color: var(--danger); }
.tag--pr.is-draft .tag__glyph { color: var(--fg-dim); }
.tag--slack .tag__glyph { color: var(--ai); }

/* El CI cuelga del chip del PR, con su propia ranura de color: el glifo de la
   izquierda sigue hablando del PR y este de su build. */
.tag__ci { flex: 0 0 auto; font-size: 0.9em; }
.tag__ci.is-ci-success { color: var(--accent); }
.tag__ci.is-ci-failure,
.tag__ci.is-ci-error { color: var(--danger); }
.tag__ci.is-ci-pending,
.tag__ci.is-ci-expected { color: var(--warn); }

.tag-empty {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  color: var(--fg-dimmer);
  padding: 0 0.2rem;
}
</style>
