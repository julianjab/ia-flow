<script setup lang="ts">
import type { ImprovementProposal, ImprovementTarget } from '@ia-flow/shared';
import { computed } from 'vue';
import { useGithubSessionStore } from '@/stores/githubSession';
import type { DecisionState } from './store';

// Una mejora que propuso un agente. No se abre sola: la persona la abre como issue —con SU login
// de GitHub— o la descarta. Sin login no sale ninguna request: se pide el login.

const props = defineProps<{
  proposal: ImprovementProposal;
  state?: DecisionState;
}>();

const emit = defineEmits<{ (e: 'run'): void; (e: 'dismiss'): void; (e: 'open', ref: string): void }>();

const session = useGithubSessionStore();

const TARGETS: Record<ImprovementTarget, string> = {
  docs: 'Docs del repo',
  config: 'Config del runner',
  engine: 'Engine',
};

const running = computed(() => props.state?.status === 'running');
const issueUrl = computed(() => props.state?.url ?? props.proposal.issue_url);
const done = computed(() => props.proposal.status === 'opened' || props.state?.status === 'done');
</script>

<template>
  <div class="ic" :data-done="done">
    <p class="ic__head">
      <strong class="ic__title" data-test="title">{{ proposal.title }}</strong>
      <span class="ic__chip" data-test="target">{{ TARGETS[proposal.target] }}</span>
    </p>
    <p class="ic__meta">
      <span class="ic__repo mono" data-test="repo">{{ proposal.repo }}</span>
      <!-- La tarea de origen no se repite como card: su ref la abre en la bandeja. -->
      <button type="button" class="ic__ref mono" data-test="task" @click="emit('open', proposal.task_ref)">
        {{ proposal.task_ref }} →
      </button>
      <a v-if="proposal.pr_url" class="ic__link" data-test="pr" :href="proposal.pr_url" target="_blank" rel="noopener">PR ↗</a>
    </p>
    <!-- Lo dijo el modelo: `--fg-mute`, nunca un color de estado (R16). -->
    <p class="ic__why"><span class="ic__ai" aria-hidden="true">✦</span> {{ proposal.reason }}</p>
    <details class="ic__body">
      <summary>Ver el issue</summary>
      <blockquote class="ic__quote" data-test="body">{{ proposal.body }}</blockquote>
      <p v-if="proposal.labels?.length" class="ic__labels mono">{{ proposal.labels.join(' · ') }}</p>
    </details>

    <div v-if="!done" class="ic__row">
      <button
        v-if="session.github"
        type="button"
        class="btn btn--primary"
        data-test="run"
        :disabled="running"
        @click="emit('run')"
      >
        {{ running ? 'Abriendo…' : 'Abrir issue' }}
      </button>
      <button v-else type="button" class="btn btn--primary" data-test="login" @click="session.requestLogin()">
        Iniciar sesión con GitHub
      </button>
      <button type="button" class="btn" data-test="dismiss" :disabled="running" @click="emit('dismiss')">
        Descartar
      </button>
    </div>
    <p v-if="!session.github && !done" class="ic__hint">
      → Para decidirla tenés que iniciar sesión: queda firmada con tu usuario de GitHub.
    </p>

    <p v-if="done" class="ic__done" role="status">
      ✓ Abierto<template v-if="issueUrl"> · <a class="ic__link" data-test="issue" :href="issueUrl" target="_blank" rel="noopener">{{ state?.message ?? issueUrl }}</a></template>
    </p>
    <p v-if="state?.status === 'error'" class="ic__err" role="alert">✕ {{ state.message }}</p>
  </div>
</template>

<style scoped>
.ic { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.6rem 0.75rem; border: 1px solid var(--accent); border-radius: var(--radius); background: var(--panel-alt); }
.ic[data-done='true'] { border-color: var(--border); }
.ic p { margin: 0; overflow-wrap: anywhere; }
.ic__head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; }
.ic__title { color: var(--fg); }
/* Chip que no se toca: `--row-h`, mono, `--radius-sm`. */
.ic__chip { padding: 0 0.4rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-hi); color: var(--fg-mute); font-family: var(--font-mono); font-size: var(--fs-micro); line-height: var(--row-h); }
.ic__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.75rem; }
.ic__repo { color: var(--info); font-size: var(--fs-micro); }
/* Link de texto en la línea: el blanco táctil lo da el alto (R1), no una caja. */
.ic__ref { min-height: var(--tap-h); padding: 0; border: 0; background: none; color: var(--info); font-size: var(--fs-body-sm); text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.ic__ref:hover { text-decoration: underline; }
.ic__link { display: inline-flex; align-items: center; min-height: var(--tap-h); color: var(--accent); font-size: var(--fs-body-sm); }
.ic__link:hover { background: none; color: var(--accent); text-decoration: underline; }
.ic__why { color: var(--fg-mute); font-size: var(--fs-body-sm); line-height: 1.45; }
.ic__ai { color: var(--ai); }
.ic__body summary { display: list-item; line-height: var(--tap-h); color: var(--info); font-size: var(--fs-body-sm); cursor: pointer; }
.ic__quote { margin: 0; padding: 0.4rem 0.6rem; border-left: 2px solid var(--ai); background: var(--panel); color: var(--fg-mute); font-size: var(--fs-body-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
.ic__labels { margin: 0.35rem 0 0; color: var(--fg-dim); font-size: var(--fs-micro); }
.ic__row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.15rem; }
.ic__hint { color: var(--info); font-size: var(--fs-body-sm); }
.ic__done { color: var(--accent); font-size: var(--fs-body-sm); font-weight: 600; }
.ic__err { color: var(--danger); font-size: var(--fs-body-sm); }
</style>
