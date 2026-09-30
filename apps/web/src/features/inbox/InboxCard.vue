<script setup lang="ts">
import type { InboxItem } from '@ia-flow/shared';
import { computed } from 'vue';
import { formatRelative } from '@/composables/formatRelative';
import { KIND_LABEL } from '@/features/inbox/labels';
import type { DetailState } from '@/features/inbox/store';
import TaskDetailPanel from '@/features/inbox/TaskDetailPanel.vue';

// Una tarjeta de la bandeja: qué es (caso · ref · status · agente · hace cuánto),
// el título, UNA línea de por qué está acá, y —abierta— su detalle. Todo lo que
// decide está visible sin `:hover` (R7); el detalle se abre con un toque.

const props = defineProps<{ item: InboxItem; open: boolean; detail?: DetailState }>();
const emit = defineEmits<{ (e: 'toggle', ref: string): void; (e: 'reload', ref: string): void }>();

const age = computed(() => formatRelative(props.item.since));
const agent = computed(() => props.item.execution?.agent_id);
const running = computed(() => props.item.group === 'run');
const detailId = computed(() => `detail-${props.item.ref}`);
</script>

<template>
  <article class="card" :data-group="item.group" :data-open="open">
    <button
      type="button"
      class="card__row"
      :aria-expanded="open"
      :aria-controls="detailId"
      @click="emit('toggle', item.ref)"
    >
      <span class="card__meta">
        <span v-if="running" class="live-dot" aria-hidden="true" />
        <span class="card__kind">{{ KIND_LABEL[item.kind] }}</span>
        <span class="card__ref mono">{{ item.ref }}</span>
        <span v-if="item.status" class="card__chip">{{ item.status }}</span>
        <span v-if="agent" class="card__agent mono">{{ agent }}</span>
      </span>
      <span class="card__age mono">{{ age }}</span>
      <span class="card__title">{{ item.title }}</span>
      <span class="card__why">{{ item.why }}</span>
      <span v-if="item.unlocks" class="card__unlocks">
        destraba {{ item.unlocks }} {{ item.unlocks === 1 ? 'tarea' : 'tareas' }}
      </span>
    </button>

    <div v-if="open" :id="detailId">
      <TaskDetailPanel :item="item" :detail="detail" @reload="emit('reload', item.ref)" />
    </div>
  </article>
</template>

<style scoped>
.card {
  --c: var(--fg-mute);
  --cb: var(--panel-hi);
  border: 1px solid var(--border);
  border-left: 3px solid var(--c);
  border-radius: var(--radius);
  background: var(--panel);
  min-width: 0;
}
.card[data-group='need'] { --c: var(--warn); --cb: var(--yellow-bg); }
.card[data-group='fail'] { --c: var(--danger); --cb: var(--red-bg); }
.card[data-group='run'] { --c: var(--accent); --cb: var(--green-bg); }
.card[data-open='true'] { border-color: var(--border-hi); border-left-color: var(--c); }

.card__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.2rem 0.75rem;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0.6rem 0.75rem;
  border: 0;
  border-radius: var(--radius);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.card__row:hover { background: var(--panel-alt); }
.card__row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }

.card__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.15rem 0.6rem; min-width: 0; }
.card__kind { color: var(--c); font-size: var(--fs-chrome); font-weight: 600; text-transform: uppercase; letter-spacing: var(--tracking-lbl); }
.card__ref { color: var(--fg); font-size: var(--fs-chrome); }
.card__agent { color: var(--fg-dim); font-size: var(--fs-chrome); }
/* Chip: una sola caja para todo tipo; el tipo lo da el color del texto. */
.card__chip {
  line-height: var(--row-h);
  padding: 0 0.4rem;
  border-radius: var(--radius-sm);
  background: var(--cb);
  color: var(--c);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.card__age { color: var(--fg-dim); font-size: var(--fs-chrome); white-space: nowrap; align-self: start; font-variant-numeric: tabular-nums; }
/* El título es prosa: Sans, y envuelve — esconder el final esconde lo que distingue una tarjeta de otra. */
.card__title { grid-column: 1 / -1; color: var(--fg); font-weight: 600; overflow-wrap: anywhere; }
.card__why { grid-column: 1 / -1; color: var(--fg-mute); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.card__unlocks { grid-column: 1 / -1; color: var(--warn); font-size: var(--fs-body-sm); }
</style>
