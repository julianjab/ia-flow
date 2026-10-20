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
  <BottomSheet :open="session.loginOpen" title="Entrar con GitHub" @close="cancel">
    <div class="gl">
      <p class="gl__lead">
        Tus acciones sobre el board —mergear, aprobar, destrabar— quedan firmadas con tu usuario
        de GitHub, no con el del runner.
      </p>

      <p v-if="phase === 'starting'" class="gl__status">Pidiendo un código…</p>

      <template v-else-if="phase === 'waiting' && code">
        <!-- El orden importa (primero se abre GitHub, después se escribe el código): acá el número es información. -->
        <ol class="gl__steps">
          <li class="gl__step">
            Abrí <span class="mono gl__uri">{{ code.verification_uri.replace(/^https?:\/\//, '') }}</span>
          </li>
          <li class="gl__step">Escribí este código</li>
        </ol>
        <output class="gl__usercode" data-test="user-code">{{ code.user_code }}</output>
        <div class="gl__acts">
          <CopyButton v-slot="{ copied }" :value="code.user_code" label="el código" class="btn gl__copy">
            {{ copied ? '✓ Copiado' : 'Copiar' }}
          </CopyButton>
          <a :href="code.verification_uri" target="_blank" rel="noopener noreferrer" class="btn btn--primary gl__open">Abrir GitHub ↗</a>
        </div>
        <p class="gl__status"><span class="live-dot" /> Esperando que lo autorices…</p>
      </template>

      <div v-else-if="phase === 'failed'" class="gl__fail" role="alert">
        <p class="gl__err">✕ {{ failure }}</p>
        <button type="button" class="btn btn--primary" @click="start">Pedir otro código</button>
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
.gl__steps { display: flex; flex-direction: column; gap: 0.5rem; margin: 0; padding: 0; list-style: none; counter-reset: gl; }
.gl__step { display: flex; align-items: center; gap: 0.6rem; color: var(--fg); counter-increment: gl; }
.gl__step::before {
  content: counter(gl);
  flex: none;
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  background: var(--panel-hi);
  color: var(--fg-mute);
  font-size: var(--fs-chrome);
}
.gl__uri { color: var(--info); overflow-wrap: anywhere; }
/* El código se lee y se copia: mono, grande, seleccionable de un toque, en su caja punteada. */
.gl__usercode {
  display: block;
  padding: 0.75rem;
  border: 1px dashed var(--border-hi);
  border-radius: calc(var(--radius) * 2);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-display);
  font-weight: 600;
  letter-spacing: 0.15em;
  text-align: center;
  user-select: all;
}
.gl__acts { display: flex; gap: 0.5rem; }
.gl__acts > * { flex: 1; min-height: var(--tap-h-lg); }
/* `a:hover` global pinta video inverso: el botón-link conserva su primario. */
.gl__open { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }
.gl__open:hover { background: var(--green-hi); color: var(--bg); }
/* CopyButton es un glifo sin caja: acá es un botón de verdad (la caja de `.btn`, que su estilo
   scoped pisa). */
.gl__acts .gl__copy {
  border: 1px solid var(--border-hi);
  border-radius: var(--radius);
  background: var(--panel-alt);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  font-weight: 500;
}
.gl__acts .gl__copy.is-copied { color: var(--accent); }
.gl__status { margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); display: flex; align-items: center; gap: 0.5rem; }
.gl__fail { display: flex; flex-direction: column; gap: 0.6rem; align-items: flex-start; }
.gl__err { margin: 0; color: var(--danger); }
</style>
