<script setup lang="ts">
import type { AssistantProposal } from '@ia-flow/shared';
import { useGithubSessionStore } from '@/stores/githubSession';

// Una acción que el asistente PROPONE. No se ejecuta sola: el usuario la
// confirma con un botón y queda firmada con su login de GitHub. Sin login no
// sale ninguna request — se pide el login y la propuesta queda como estaba.

defineProps<{
  proposal: AssistantProposal;
  status: 'open' | 'running' | 'done' | 'dismissed';
  message?: string;
  error?: string;
}>();

const emit = defineEmits<{ (e: 'run'): void; (e: 'dismiss'): void }>();

const session = useGithubSessionStore();
</script>

<template>
  <div class="pc" :data-status="status">
    <p class="uc-label pc__kind">acción propuesta</p>
    <p class="pc__what"><strong>{{ proposal.label }}</strong> <span class="mono">{{ proposal.ref }}</span></p>
    <!-- Lo dijo el modelo: `--fg-mute`, nunca un color de estado (R16). -->
    <p class="pc__why"><span class="pc__ai" aria-hidden="true">✦</span> {{ proposal.reason }}</p>
    <blockquote v-if="proposal.comment" class="pc__comment">{{ proposal.comment }}</blockquote>

    <div v-if="status === 'open' || status === 'running'" class="pc__row">
      <button
        v-if="session.github"
        type="button"
        class="btn btn--primary"
        data-test="run"
        :disabled="status === 'running'"
        @click="emit('run')"
      >
        {{ status === 'running' ? 'Ejecutando…' : 'Ejecutar' }}
      </button>
      <button v-else type="button" class="btn btn--primary" data-test="login" @click="session.requestLogin()">
        Iniciar sesión con GitHub
      </button>
      <button type="button" class="btn" data-test="dismiss" :disabled="status === 'running'" @click="emit('dismiss')">
        Descartar
      </button>
    </div>
    <p v-if="!session.github && status === 'open'" class="pc__hint">
      → Para ejecutarla tenés que iniciar sesión: queda firmada con tu usuario de GitHub.
    </p>

    <p v-if="status === 'done'" class="pc__done" role="status">✓ Ejecutada<template v-if="message"> · {{ message }}</template></p>
    <p v-else-if="status === 'dismissed'" class="pc__dim">Descartada.</p>
    <p v-if="error" class="pc__err" role="alert">✕ {{ error }}</p>
  </div>
</template>

<style scoped>
.pc { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.6rem 0.75rem; border: 1px solid var(--accent); border-radius: var(--radius); background: var(--panel-alt); }
.pc[data-status='dismissed'] { border-color: var(--border); opacity: 0.7; }
.pc p { margin: 0; overflow-wrap: anywhere; }
.pc__kind { color: var(--fg-dim); }
.pc__what { color: var(--fg); }
.pc__why { color: var(--fg-mute); font-size: var(--fs-body-sm); line-height: 1.45; }
.pc__ai { color: var(--ai); }
.pc__comment { margin: 0; padding: 0.4rem 0.6rem; border-left: 2px solid var(--ai); background: var(--panel); color: var(--fg-mute); font-size: var(--fs-body-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
.pc__row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.15rem; }
.pc__hint { color: var(--info); font-size: var(--fs-body-sm); }
.pc__done { color: var(--accent); font-size: var(--fs-body-sm); font-weight: 600; }
.pc__dim { color: var(--fg-dim); font-size: var(--fs-body-sm); }
.pc__err { color: var(--danger); font-size: var(--fs-body-sm); }
</style>
