<script setup lang="ts">
import type { InboxItem } from '@ia-flow/shared';
import type { QueueAction } from '@/features/inbox/queue/kinds';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import InlineConfirm from '@/features/inbox/decisions/InlineConfirm.vue';
import { useDecisionAction } from '@/features/inbox/useDecisionAction';

// Un botón de acción que se arregla solo en el lugar: la confirmación lo reemplaza y el error
// queda debajo de él. Es el de las acciones secundarias del detalle, de cada hija de un grupo,
// de «Detener…» y del feed. El botón principal de una fila lo arma la fila (va arriba a la
// derecha y su confirmación ocupa el ancho de la card).

const props = defineProps<{
  action: QueueAction;
  item: Pick<InboxItem, 'ref' | 'pr' | 'action_defs'>;
  ghost?: boolean;
  /** Riesgosa («Detener…»): contorno `--danger`, pesa más que una neutra. */
  danger?: boolean;
  /** El texto que acompaña la acción (lo escribe el detalle). */
  comment?: string;
  /** Deshabilitado por quien lo usa (p. ej. falta el texto que la acción exige). */
  blocked?: boolean;
}>();
const emit = defineEmits<{ (e: 'done'): void }>();

const act = useDecisionAction({ action: () => props.action, targets: () => [props.item] });

async function press() {
  act.comment.value = props.comment ?? '';
  const outcome = await act.ask();
  if (outcome === 'ran' && act.done.value) emit('done');
}

async function confirm() {
  if (await act.confirm()) emit('done');
}
</script>

<template>
  <span class="ab" :data-action="action.id">
    <InlineConfirm
      v-if="act.confirming.value && act.copy.value"
      class="ab__wide"
      :text="act.copy.value.text"
      :label="act.copy.value.label"
      :busy="act.busy.value"
      :danger="danger"
      @cancel="act.cancel()"
      @confirm="confirm"
    />
    <button
      v-else
      type="button"
      class="btn"
      :class="{ 'btn--ghost': ghost, 'btn--danger': danger && !ghost }"
      :disabled="act.busy.value || blocked"
      @click="press"
    >
      {{ act.busy.value ? '· ejecutando' : action.label }}
    </button>
    <ActionError
      v-if="act.failure.value"
      class="ab__wide"
      :failure="act.failure.value"
      :busy="act.busy.value"
      @retry="act.retry()"
    />
    <span v-else-if="act.done.value" class="ab__wide ab__ok" role="status">
      ✓ {{ act.done.value.message }}<template v-if="act.done.value.github_login"> · @{{ act.done.value.github_login }}</template>
    </span>
  </span>
</template>

<style scoped>
.ab { display: contents; }
.ab__wide { flex: 1 1 100%; }
.ab__ok { color: var(--accent); font-size: var(--fs-body-sm); }
</style>
