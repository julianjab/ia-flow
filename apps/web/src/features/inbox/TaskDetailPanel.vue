<script setup lang="ts">
import type { InboxItem } from '@ia-flow/shared';
import { computed, ref } from 'vue';
import { formatRelative } from '@/composables/formatRelative';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import { loadFailure } from '@/features/inbox/queue/advice';
import { prShortOf, refUrl, shortRef } from '@/features/inbox/queue/shortRef';
import type { DetailState } from '@/features/inbox/store';
import TaskActions from '@/features/inbox/TaskActions.vue';
import TaskEvents from '@/features/inbox/TaskEvents.vue';
import TaskExecutions from '@/features/inbox/TaskExecutions.vue';
import { useAssistantStore } from '@/stores/assistant';

// El detalle de una tarea en grande (el panel de detalle): lo que dijo el agente, sus
// ejecuciones —cada una con su traza al abrirla, y su falla, una sola vez—, debajo los eventos,
// cada uno con el link a la ejecución que arrancó, y las acciones. Cada banda se omite entera
// cuando el runner no tiene el dato (R13).

const props = defineProps<{ item: InboxItem; detail?: DetailState }>();
const emit = defineEmits<{ (e: 'reload'): void }>();

const assistant = useAssistantStore();

/** El detalle trae la card más fresca que la lista; mientras carga, la de la lista. */
const item = computed(() => props.detail?.data?.item ?? props.item);
const data = computed(() => props.detail?.data ?? null);
const execution = computed(() => item.value.execution);
const executionIds = computed(() => data.value?.executions.map((e) => e.id) ?? []);
/** La ejecución que un evento pidió abrir; `at` hace que el mismo pedido dos veces vuelva a saltar. */
const focus = ref<{ id: string; at: number } | null>(null);
const openExecution = (id: string) => {
  focus.value = { id, at: Date.now() };
};
const agent = computed(() => execution.value?.agent_id);
/** Cuándo lo pensó el agente: al cerrar su corrida (o al arrancarla, si sigue). */
const saidAt = computed(() => execution.value?.closed_at ?? execution.value?.started_at);
/** El PR, con el mismo repo corto que el issue: `seller#4302`. */
const prShort = computed(() => prShortOf(item.value));
/** Lo que dijo el agente, salvo que repita el error crudo: ése ya está en «Detalle técnico». */
const said = computed(() =>
  item.value.agent_said && item.value.agent_said !== execution.value?.failure?.message ? item.value.agent_said : '',
);
const failure = computed(() =>
  props.detail?.error ? loadFailure('cargar el detalle', props.detail.error) : null,
);

function ask() {
  assistant.open({ kind: 'task', ref: props.item.ref });
}
</script>

<template>
  <div class="td">
    <blockquote v-if="said" class="td__quote">
      <p class="td__who">
        <span class="td__ai"><span aria-hidden="true">✦</span> {{ agent ?? 'el agente' }} dice</span>
        <time v-if="saidAt" :datetime="saidAt" :title="saidAt"> · {{ formatRelative(saidAt) }}</time>
      </p>
      {{ said }}
    </blockquote>

    <p v-if="item.blocked_by?.length" class="td__exec">
      <span class="uc-label">bloqueada por</span>
      <template v-for="ref in item.blocked_by" :key="ref">
        <RefLink v-if="refUrl(ref)" :short="shortRef(ref)" :url="refUrl(ref) ?? ''" />
        <span v-else class="mono">{{ shortRef(ref) }}</span>
      </template>
    </p>

    <p class="td__links">
      <span class="uc-label">issue</span>
      <RefLink :short="shortRef(item.ref)" :url="item.url" />
      <template v-if="item.pr">
        <span class="uc-label">PR</span>
        <RefLink :short="prShort" :url="item.pr.url" />
      </template>
    </p>

    <details v-if="data?.description" class="td__desc">
      <summary>Descripción del issue</summary>
      <p class="td__text">{{ data.description }}</p>
    </details>

    <p v-if="detail?.loading" class="td__dim">· cargando el detalle…</p>
    <ActionError v-else-if="failure" :failure="failure" @retry="emit('reload')" />

    <TaskExecutions
      v-if="data"
      :task-ref="item.ref"
      :executions="data.executions"
      :live-trace="data.trace"
      :focus="focus"
    />
    <TaskEvents
      v-if="data"
      :task-ref="item.ref"
      :events="data.events"
      :limit="Infinity"
      :execution-ids="executionIds"
      @open-execution="openExecution"
    />

    <TaskActions :item="item" />

    <button type="button" class="btn btn--ghost td__ask" @click="ask">
      ◆ Preguntarle al asistente sobre {{ shortRef(item.ref) }}
    </button>
  </div>
</template>

<style scoped>
.td { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.75rem; border-top: 1px solid var(--border); }
.td__quote {
  margin: 0;
  padding: 0.6rem 0.75rem;
  border-left: 2px solid var(--ai);
  background: var(--panel-alt);
  color: var(--fg-mute);
  font-size: var(--fs-body-sm);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* R16: `--ai` sólo marca (✦ y quién); el texto inferido va en --fg-mute, con su hora. */
.td__who { margin: 0 0 0.25rem; color: var(--fg-dim); font-family: var(--font-mono); font-size: var(--fs-micro); }
.td__ai { color: var(--ai); }
.td__exec { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; margin: 0; font-size: var(--fs-body-sm); }
.td__dim { color: var(--fg-dim); }
.td__links { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.5rem; margin: 0; }
.td__links .uc-label + :deep(.ref) { margin-right: 0.75rem; }
.td__desc summary { display: flex; align-items: center; min-height: var(--tap-h); color: var(--fg-dim); font-size: var(--fs-body-sm); cursor: pointer; }
.td__text { margin: 0; color: var(--fg-mute); font-size: var(--fs-body-sm); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 16rem; overflow-y: auto; }
.td__ask { align-self: flex-start; padding: 0; color: var(--info); }
.td__ask:hover { border-color: transparent; color: var(--fg); text-decoration: underline; }
</style>
