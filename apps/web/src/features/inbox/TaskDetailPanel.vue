<script setup lang="ts">
import type { InboxItem } from '@ia-flow/shared';
import { computed, ref } from 'vue';
import { formatRelative } from '@/composables/formatRelative';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import { loadFailure } from '@/features/inbox/queue/advice';
import { prShortOf, refUrl, shortRef } from '@/features/inbox/queue/shortRef';
import { type DetailState, useInboxStore } from '@/features/inbox/store';
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
const store = useInboxStore();
/** Lo que la bloquea y está en el board se abre acá mismo (como el menú); lo demás, en GitHub. */
const inBoard = (ref: string) => store.inbox?.items.some((i) => i.ref === ref) ?? false;

/** El detalle trae la card más fresca que la lista; mientras carga, la de la lista. */
const item = computed(() => props.detail?.data?.item ?? props.item);
const data = computed(() => props.detail?.data ?? null);
const execution = computed(() => item.value.execution);
const executionIds = computed(() => data.value?.executions.map((e) => e.id) ?? []);
/** La ejecución que un evento pidió abrir; `at` hace que el mismo pedido dos veces vuelva a saltar. */
const focus = ref<{ id: string; at: number } | null>(null);
const openExecution = (id: string) => {
  tab.value = 'runs';
  focus.value = { id, at: Date.now() };
};
const tab = ref<'runs' | 'events'>('runs');
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

    <p v-if="item.blocked_by?.length || item.unlocks" class="td__exec">
      <template v-if="item.blocked_by?.length">
        <span class="uc-label">Bloqueada por</span>
        <template v-for="ref in item.blocked_by" :key="ref">
          <button
            v-if="inBoard(ref)"
            type="button"
            class="td__goto"
            :data-test="`goto-${ref}`"
            :title="`Ver ${ref}`"
            @click="store.expand(ref)"
          >
            {{ shortRef(ref) }} ›
          </button>
          <RefLink v-else-if="refUrl(ref)" :short="shortRef(ref)" :url="refUrl(ref) ?? ''" />
          <span v-else class="mono">{{ shortRef(ref) }}</span>
        </template>
      </template>
      <span v-if="item.unlocks" class="td__unlocks">Destraba {{ item.unlocks }}</span>
    </p>

    <p class="td__links">
      <span class="uc-label">Issue</span>
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

    <!-- Corridas o eventos, uno a la vez: en un teléfono eran dos pantallas de scroll apiladas. -->
    <template v-if="data">
      <div class="td__tabs" role="tablist" aria-label="Historia de la tarea">
        <button
          type="button"
          role="tab"
          class="td__tab"
          data-test="tab-runs"
          :aria-selected="tab === 'runs'"
          @click="tab = 'runs'"
        >
          Corridas <span class="td__n">{{ data.executions.length }}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="td__tab"
          data-test="tab-events"
          :aria-selected="tab === 'events'"
          @click="tab = 'events'"
        >
          Eventos <span class="td__n">{{ data.events.length }}</span>
        </button>
      </div>
      <!-- v-show y no v-if: un evento abre su ejecución, y la lista tiene que estar montada para saltar. -->
      <div v-show="tab === 'runs'" class="td__pane" role="tabpanel">
        <TaskExecutions :task-ref="item.ref" :executions="data.executions" :live-trace="data.trace" :focus="focus" />
        <p v-if="!data.executions.length" class="td__dim">Todavía no corrió ningún agente.</p>
      </div>
      <div v-show="tab === 'events'" class="td__pane" role="tabpanel">
        <TaskEvents
          :task-ref="item.ref"
          :events="data.events"
          :limit="Infinity"
          :execution-ids="executionIds"
          @open-execution="openExecution"
        />
      </div>
    </template>

    <button type="button" class="td__ask" @click="ask">
      <span aria-hidden="true">✦</span> Preguntarle al asistente sobre {{ shortRef(item.ref) }}
    </button>

    <TaskActions :item="item" bar />
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
.td__who { margin: 0 0 0.25rem; color: var(--fg-dim); font-size: var(--fs-chrome); }
.td__ai { color: var(--ai); }
.td__exec { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; margin: 0; font-size: var(--fs-body-sm); }
.td__dim { color: var(--fg-dim); }
.td__goto { min-height: var(--tap-h); padding: 0 0.25rem; border: 0; background: none; color: var(--accent); font: inherit; cursor: pointer; }
.td__goto:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.td__unlocks { color: var(--accent); }
.td__links { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.5rem; margin: 0; }
.td__links .uc-label + :deep(.ref) { margin-right: 0.75rem; }
.td__desc summary { display: flex; align-items: center; min-height: var(--tap-h); color: var(--fg-dim); font-size: var(--fs-body-sm); cursor: pointer; }
.td__text { margin: 0; color: var(--fg-mute); font-size: var(--fs-body-sm); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 16rem; overflow-y: auto; }
.td__ask { align-self: flex-start; display: inline-flex; align-items: center; gap: 0.4rem; min-height: var(--tap-h); padding: 0; border: 0; background: none; color: var(--info); font: inherit; font-size: var(--fs-body-sm); cursor: pointer; }
.td__ask span { color: var(--ai); }
.td__ask:hover { color: var(--fg); text-decoration: underline; }
.td__tabs { display: flex; gap: 1.25rem; margin: 0 -1rem; padding: 0 1rem; border-bottom: 1px solid var(--border); }
.td__tab { min-height: var(--tap-h); margin-bottom: -1px; padding: 0; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--fg-dim); font: inherit; font-size: var(--fs-body-sm); cursor: pointer; }
.td__tab:hover { color: var(--fg); }
.td__tab[aria-selected='true'] { border-bottom-color: var(--accent); color: var(--fg); }
.td__n { color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.td__pane { min-width: 0; }
/* La pestaña ya dice qué es y cuántas hay: el título de la lista sobra. */
.td__pane :deep(.tx__head),
.td__pane :deep(.ev__label) { display: none; }
</style>
