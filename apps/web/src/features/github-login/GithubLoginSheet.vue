<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { pollDeviceFlow, startDeviceFlow } from '@/features/github-login/api';
import { type DeviceOutcome, pollUntilDone } from '@/features/github-login/deviceFlow';
import { useGithubSessionStore } from '@/stores/githubSession';
import BottomSheet from '@/ui/BottomSheet.vue';
import CopyButton from '@/ui/CopyButton.vue';
import type { DeviceCode } from '@ia-flow/shared';

// El login con GitHub por device flow. Se abre desde cualquier parte con
// `useGithubSessionStore().requestLogin()` y se monta UNA vez, en App.vue.
// Las acciones sobre el board (mergear, aprobar, destrabar) quedan firmadas con
// el usuario que se loguea acá, no con el bot del runner.

const session = useGithubSessionStore();

type Phase = 'starting' | 'waiting' | 'failed';
const phase = ref<Phase>('starting');
const code = ref<DeviceCode | null>(null);
const failure = ref('');
let abort: AbortController | null = null;

const FAILURE_COPY: Record<'denied' | 'expired', string> = {
  denied: 'Rechazaste la autorización en GitHub.',
  expired: 'El código venció antes de que lo autorizaras.',
};

function fail(outcome: DeviceOutcome | { status: 'error'; message: string }) {
  phase.value = 'failed';
  if (outcome.status === 'denied' || outcome.status === 'expired') {
    failure.value = FAILURE_COPY[outcome.status];
  } else if (outcome.status === 'error') {
    failure.value = outcome.message;
  }
}

async function start() {
  abort?.abort();
  const mine = new AbortController();
  abort = mine;
  phase.value = 'starting';
  code.value = null;
  failure.value = '';
  try {
    const device = await startDeviceFlow();
    if (mine.signal.aborted) return;
    code.value = device;
    phase.value = 'waiting';
    const outcome = await pollUntilDone({
      deviceCode: device.device_code,
      interval: device.interval,
      expiresIn: device.expires_in,
      poll: pollDeviceFlow,
      signal: mine.signal,
    });
    if (outcome.status === 'ok') {
      const { status: _, token, ...rest } = outcome;
      await session.signIn({ ...rest, access_token: token });
    }
    else if (outcome.status !== 'cancelled') fail(outcome);
  } catch (err) {
    if (mine.signal.aborted) return;
    fail({ status: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

function cancel() {
  abort?.abort();
  session.cancelLogin();
}

watch(
  () => session.loginOpen,
  (open) => {
    if (open) void start();
    else abort?.abort();
  },
  { immediate: true },
);

onBeforeUnmount(() => abort?.abort());
</script>

<template>
  <BottomSheet :open="session.loginOpen" title="Iniciar sesión con GitHub" @close="cancel">
    <div class="gl">
      <p class="gl__lead">
        Tus acciones sobre el board —mergear, aprobar, destrabar— quedan firmadas con tu usuario
        de GitHub, no con el del runner.
      </p>

      <p v-if="phase === 'starting'" class="gl__status">· pidiendo un código…</p>

      <template v-else-if="phase === 'waiting' && code">
        <p class="gl__step">
          1. Abrí
          <a :href="code.verification_uri" target="_blank" rel="noopener noreferrer" class="gl__link">
            {{ code.verification_uri }} ↗
          </a>
        </p>
        <p class="gl__step">2. Ingresá este código:</p>
        <div class="gl__code">
          <output class="gl__usercode" data-test="user-code">{{ code.user_code }}</output>
          <CopyButton :value="code.user_code" label="el código" />
        </div>
        <p class="gl__status"><span class="live-dot" /> esperando que lo autorices…</p>
      </template>

      <div v-else-if="phase === 'failed'" class="gl__fail" role="alert">
        <p class="gl__err">✕ {{ failure }}</p>
        <button type="button" class="btn btn--primary" @click="start">Reintentar</button>
      </div>
    </div>

    <template #footer>
      <button type="button" class="btn" @click="cancel">Cancelar</button>
    </template>
  </BottomSheet>
</template>

<style scoped>
.gl { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.5rem 1rem; }
.gl__lead { margin: 0; color: var(--fg-mute); font-size: var(--fs-body-sm); line-height: 1.5; }
.gl__step { margin: 0; color: var(--fg); }
/* `a:hover` global pinta el fondo: se pisa explícitamente (DESIGN_SYSTEM «Trampas»). */
.gl__link { display: inline-flex; align-items: center; min-height: var(--tap-h); }
.gl__link:hover { background: transparent; color: var(--green-hi); text-decoration: underline; }
.gl__code { display: flex; align-items: center; gap: 0.75rem; }
/* El código se lee y se copia: mono, grande y seleccionable de un toque. */
.gl__usercode {
  font-family: var(--font-mono);
  font-size: 1.6rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: var(--fg);
  user-select: all;
  padding: 0.25rem 0.75rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius);
  background: var(--panel-hi);
}
.gl__status { margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); display: flex; align-items: center; gap: 0.5rem; }
.gl__fail { display: flex; flex-direction: column; gap: 0.6rem; align-items: flex-start; }
.gl__err { margin: 0; color: var(--danger); }
</style>
