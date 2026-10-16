<script setup lang="ts">
import { computed, ref } from 'vue';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import { tokenOrLogin } from '@/features/inbox/githubToken';
import { actionFailure } from '@/features/inbox/queue/advice';
import { useInboxStore } from '@/features/inbox/store';

// «Mover a…» de una línea del feed: elegir la columna ya mueve la card (es reversible: se mueve de
// vuelta), firmado con tu usuario de GitHub. Sin sesión, pide el login. El error del runner (un
// agente la está corriendo, ya está ahí…) queda pegado debajo, con «Reintentar»; tras el ✓ la
// bandeja se relee y la card deja el feed.

const props = defineProps<{
  taskRef: string;
  /** `subs#1203`: para el nombre accesible. */
  short: string;
  /** Las columnas del board, sin la suya. */
  columns: readonly string[];
}>();

const store = useInboxStore();
const state = computed(() => store.moves[props.taskRef]);
const busy = computed(() => state.value?.pending === true);
/** La última columna elegida: la del «moviendo a…» y la del reintento. */
const target = ref('');

const failure = computed(() => {
  const s = state.value;
  if (!s || s.pending) return null;
  const message = s.error ?? (s.result && !s.result.ok ? s.result.message : null);
  return message ? actionFailure('Mover la card', message) : null;
});
const done = computed(() => (state.value?.result?.ok ? state.value.result : null));

async function move(status: string): Promise<void> {
  if (!status || busy.value) return;
  target.value = status;
  store.clearMove(props.taskRef);
  const token = await tokenOrLogin();
  if (token) await store.moveTask(props.taskRef, status, token);
}

/** El `<select>` vuelve a «Mover a…»: es un menú, no un valor que queda elegido. */
function pick(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const status = select.value;
  select.value = '';
  void move(status);
}
</script>

<template>
  <span class="mv" data-test="move-to">
    <select
      class="ff-field mv__select"
      :aria-label="`Mover ${short} a otra columna`"
      :disabled="busy"
      @change="pick"
    >
      <option value="">{{ busy ? `· moviendo a ${target}` : 'Mover a…' }}</option>
      <option v-for="column in columns" :key="column" :value="column">{{ column }}</option>
    </select>
    <ActionError v-if="failure" class="mv__wide" :failure="failure" :busy="busy" @retry="move(target)" />
    <span v-else-if="done" class="mv__wide mv__ok" role="status">
      ✓ {{ done.message }}<template v-if="done.github_login"> · @{{ done.github_login }}</template>
    </span>
  </span>
</template>

<style scoped src="@/ui/form-fields.css" />
<style scoped>
.mv { display: contents; }
/* La caja es la de `.ff-field` (R18); acá sólo deja de ocupar todo el ancho de la fila. */
.mv__select { flex: none; width: auto; max-width: 12rem; color: var(--fg-mute); cursor: pointer; }
.mv__select:disabled { cursor: default; opacity: 0.7; }
.mv__wide { flex: 1 1 100%; }
.mv__ok { color: var(--accent); font-size: var(--fs-body-sm); }
</style>
