<script setup lang="ts">
import type { AssistantProposal } from '@ia-flow/shared';
import { useGithubSessionStore } from '@/stores/githubSession';

// Una acción que el asistente PROPONE. No se ejecuta sola: el usuario la
// confirma con un botón y queda firmada con su login de GitHub. Sin login no
// sale ninguna request — se pide el login y la propuesta queda como estaba.

defineProps<{
  proposal: AssistantProposal;
  status: 'open' | 'running' | 'done' | 'dismissed' | 'past';
  message?: string;
  error?: string;
}>();

const emit = defineEmits<{ (e: 'run'): void; (e: 'dismiss'): void; (e: 'open', ref: string): void }>();

const session = useGithubSessionStore();
</script>

<template>
  <div class="pc" :data-status="status">
    <p class="uc-label pc__kind">acción propuesta</p>
    <p class="pc__what">
      <strong>{{ proposal.label }}</strong>
      <!-- La tarea de la propuesta no se repite como card: su ref la abre en la bandeja. -->
      <button type="button" class="pc__ref mono" :data-test="`open-${proposal.ref}`" @click="emit('open', proposal.ref)">
        {{ proposal.ref }} →
      </button>
    </p>
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
    <!-- De una conversación retomada: la tarea pudo cambiar desde entonces. Se actúa desde la bandeja. -->
    <p v-else-if="status === 'past'" class="pc__dim">De una conversación anterior: si todavía aplica, hacelo desde la bandeja.</p>
    <p v-if="error" class="pc__err" role="alert">✕ {{ error }}</p>
  </div>
</template>

<style scoped>
.pc { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.6rem 0.75rem; border: 1px solid var(--accent); border-radius: var(--radius); background: var(--panel-alt); }
.pc[data-status='dismissed'],
.pc[data-status='past'] { border-color: var(--border); opacity: 0.7; }
.pc p { margin: 0; overflow-wrap: anywhere; }
.pc__kind { color: var(--fg-dim); }
.pc__what { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.5rem; color: var(--fg); }
/* Link de texto en la línea: el blanco táctil lo da el alto (R1), no una caja. */
.pc__ref { min-height: var(--tap-h); padding: 0; border: 0; background: none; color: var(--info); font-size: var(--fs-body-sm); text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.pc__ref:hover { text-decoration: underline; }
.pc__why { color: var(--fg-mute); font-size: var(--fs-body-sm); line-height: 1.45; }
.pc__ai { color: var(--ai); }
.pc__comment { margin: 0; padding: 0.4rem 0.6rem; border-left: 2px solid var(--ai); background: var(--panel); color: var(--fg-mute); font-size: var(--fs-body-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
.pc__row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.15rem; }
.pc__hint { color: var(--info); font-size: var(--fs-body-sm); }
.pc__done { color: var(--accent); font-size: var(--fs-body-sm); font-weight: 600; }
.pc__dim { color: var(--fg-dim); font-size: var(--fs-body-sm); }
.pc__err { color: var(--danger); font-size: var(--fs-body-sm); }
</style>
