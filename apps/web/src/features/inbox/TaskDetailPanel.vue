<script setup lang="ts">
import type { InboxItem } from '@ia-flow/shared';
import { computed } from 'vue';
import { formatRelative } from '@/composables/formatRelative';
import { executionStatus, traceLine, usageLine } from '@/features/inbox/format';
import type { DetailState } from '@/features/inbox/store';
import TaskActions from '@/features/inbox/TaskActions.vue';
import TaskEvents from '@/features/inbox/TaskEvents.vue';
import { useAssistantStore } from '@/stores/assistant';
import LogLine from '@/ui/LogLine.vue';

// El detalle de una tarjeta abierta: lo que dijo el agente, cómo va la
// ejecución, las últimas líneas de traza (en vivo), los eventos con sus
// decisiones y las acciones. Cada banda se omite entera cuando el runner no
// tiene el dato (R13): sin traza no hay caja de log vacía.

const props = defineProps<{ item: InboxItem; detail?: DetailState }>();
const emit = defineEmits<{ (e: 'reload'): void }>();

const assistant = useAssistantStore();

/** El detalle trae la card más fresca que la lista; mientras carga, la de la lista. */
const item = computed(() => props.detail?.data?.item ?? props.item);
const data = computed(() => props.detail?.data ?? null);
const execution = computed(() => item.value.execution);
const trace = computed(() => (data.value?.trace ?? []).slice(-12));
const agent = computed(() => execution.value?.agent_id);

function ask() {
  assistant.open({ kind: 'task', ref: props.item.ref });
}
</script>

<template>
  <div class="td">
    <blockquote v-if="item.agent_said" class="td__quote">
      <p class="td__who"><span class="td__ai" aria-hidden="true">✦</span> {{ agent ?? 'el agente' }} dice</p>
      {{ item.agent_said }}
    </blockquote>

    <p v-if="execution" class="td__exec">
      <span class="uc-label">ejecución</span>
      <span class="mono">{{ execution.pipeline_id }}</span>
      <span>{{ executionStatus(execution.status) }}</span>
      <span class="td__dim">{{ formatRelative(execution.started_at) }}</span>
      <span v-if="execution.exit" class="td__dim">salida <span class="mono">{{ execution.exit }}</span></span>
      <span v-if="execution.usage" class="td__dim mono">{{ usageLine(execution.usage) }}</span>
      <span v-if="execution.pause" class="td__dim">
        pausada <span class="mono">{{ execution.pause.pause_id }}</span
        ><template v-if="execution.pause.expires_at"> · vence {{ formatRelative(execution.pause.expires_at) }}</template>
      </span>
    </p>
    <p v-if="execution?.failure" class="td__fail" role="alert">
      ✕ <span class="td__dim">{{ execution.failure.by === 'agent' ? 'el agente' : 'el runner' }}:</span>
      {{ execution.failure.message }}
    </p>

    <p v-if="item.blocked_by?.length" class="td__exec">
      <span class="uc-label">bloqueada por</span>
      <span v-for="ref in item.blocked_by" :key="ref" class="mono">{{ ref }}</span>
    </p>

    <p class="td__links">
      <a :href="item.url" target="_blank" rel="noopener noreferrer" class="td__link">Abrir issue ↗</a>
      <a v-if="item.pr" :href="item.pr.url" target="_blank" rel="noopener noreferrer" class="td__link">
        PR #{{ item.pr.number }} ↗
      </a>
    </p>

    <details v-if="data?.description" class="td__desc">
      <summary>Descripción del issue</summary>
      <p class="td__text">{{ data.description }}</p>
    </details>

    <p v-if="detail?.loading" class="td__dim">· cargando el detalle…</p>
    <div v-else-if="detail?.error" class="td__fail" role="alert">
      <p>✕ {{ detail.error }}</p>
      <button type="button" class="btn" @click="emit('reload')">Reintentar</button>
    </div>

    <div v-if="trace.length" class="td__log" role="log" aria-label="Últimas líneas de traza">
      <LogLine v-for="(entry, i) in trace" :key="`${entry.span_id}-${entry.kind}-${entry.phase ?? ''}-${i}`" v-bind="traceLine(entry)" />
    </div>

    <TaskEvents v-if="data" :task-ref="item.ref" :events="data.events" />

    <TaskActions :item="item" />

    <button type="button" class="btn btn--ghost td__ask" @click="ask">
      Preguntarle al asistente sobre {{ item.ref }} →
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
/* R16: la salida de un modelo lleva ✦ y `--ai`, nada calculado los usa. */
.td__who { margin: 0 0 0.25rem; color: var(--ai); font-family: var(--font-mono); font-size: var(--fs-micro); }
.td__exec { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.75rem; margin: 0; font-size: var(--fs-body-sm); }
.td__dim { color: var(--fg-dim); }
.td__fail { margin: 0; color: var(--danger); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.td__fail p { margin: 0 0 0.5rem; }
.td__links { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; margin: 0; }
/* `a:hover` global pinta el fondo: se redefine en el propio :hover. */
.td__link { display: inline-flex; align-items: center; min-height: var(--tap-h); font-size: var(--fs-body-sm); }
.td__link:hover { background: transparent; color: var(--green-hi); text-decoration: underline; }
.td__desc summary { display: flex; align-items: center; min-height: var(--tap-h); color: var(--fg-dim); font-size: var(--fs-body-sm); cursor: pointer; }
.td__text { margin: 0; color: var(--fg-mute); font-size: var(--fs-body-sm); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 16rem; overflow-y: auto; }
/* Sin scroll horizontal (R2): la línea de log ya se trunca sola. */
.td__log { border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); padding: 0.25rem 0; overflow: hidden; }
.td__ask { align-self: flex-start; padding: 0; color: var(--info); }
.td__ask:hover { border-color: transparent; color: var(--fg); text-decoration: underline; }
</style>
