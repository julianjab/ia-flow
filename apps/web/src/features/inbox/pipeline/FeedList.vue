<script setup lang="ts">
import type { InboxProject } from '@ia-flow/shared';
import { computed } from 'vue';
import ActionButton from '@/features/inbox/decisions/ActionButton.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import Disclosure from '@/features/inbox/Disclosure.vue';
import AddToBoardForm from '@/features/inbox/pipeline/AddToBoardForm.vue';
import MoveToSelect from '@/features/inbox/pipeline/MoveToSelect.vue';
import type { FeedLine, FeedSummary } from '@/features/inbox/queue/build';
import { moveTargets } from '@/features/inbox/queue/columns';
import type { QueueAction } from '@/features/inbox/queue/kinds';

// «Qué le das al pipeline», debajo de la cola: una línea por tarea lista para arrancar (estado,
// link, título truncado y la acción que la pone a correr). El encabezado dice cuántos lugares
// libres hay para llenar (como el mockup: es la pregunta que contesta el feed) y cuántas hay
// listas. Arranca abierto en cualquier ancho: Todo no queda escondido. Las que esperan a otra tarea (el feed del runner) van
// después, con «○ espera <ref>»: todavía no pueden arrancar. Cada línea se puede mover a otra
// columna del board («Mover a…», si el runner manda las columnas), y al pie se agrega al board un
// issue que no está.

const props = withDefaults(
  defineProps<{
    feed: FeedSummary;
    /** Los proyectos del runner, con sus columnas: sin ellos no hay «Mover a…» ni formulario. */
    projects?: readonly InboxProject[];
    /** El proyecto que se está mirando. */
    project?: string | null;
  }>(),
  { projects: () => [], project: null },
);

/** Mover una card al pipeline es reversible: no confirma, pero va firmado con tu usuario. */
const actionOf = (line: FeedLine): QueueAction | null =>
  line.action ? { id: line.action.id, label: `→ ${line.action.label}`, confirms: false } : null;
const lines = computed(() =>
  props.feed.entries.map((line) => ({
    ...line,
    act: actionOf(line),
    columns: moveTargets(props.projects, line),
  })),
);
const n = computed(() => props.feed.entries.filter((e) => !e.waitingOn).length);
const waiting = computed(() => props.feed.entries.length - n.value);
const free = computed(() => {
  const free = props.feed.free;
  if (free === undefined) return null;
  return `${free} ${free === 1 ? 'lugar libre' : 'lugares libres'}`;
});
</script>

<template>
  <Disclosure :title="feed.title" open data-test="feed">
    <template #meta>
      <span v-if="free" class="uc-label fl__free" data-test="feed-free">{{ free }}</span>
      <span v-if="n" class="fl__slots">{{ n }} {{ n === 1 ? 'lista para correr' : 'listas para correr' }}</span>
      <span v-else class="fl__slots">nada listo para correr</span>
      <span v-if="waiting" class="fl__slots">· {{ waiting }} {{ waiting === 1 ? 'espera' : 'esperan' }} a otra</span>
    </template>
    <ul v-if="lines.length" class="fl__list">
      <li v-for="line in lines" :key="line.ref" class="fl__row" :data-state="line.waitingOn ? 'waiting' : 'ready'">
        <span v-if="line.waitingOn" class="fl__state fl__state--wait mono">
          ○ espera
          <RefLink v-if="line.waitingOn.url" :short="line.waitingOn.short" :url="line.waitingOn.url" />
          <template v-else>{{ line.waitingOn.short }}</template>
        </span>
        <span v-else class="fl__state mono">● lista</span>
        <RefLink :short="line.short" :url="line.url" />
        <span class="fl__title" :title="line.title">{{ line.title }}</span>
        <ActionButton v-if="line.act" ghost :action="line.act" :item="{ ref: line.ref }" />
        <MoveToSelect v-if="line.columns.length" :task-ref="line.ref" :short="line.short" :columns="line.columns" />
      </li>
    </ul>
    <AddToBoardForm v-if="projects.length" :projects="projects" :project="project" />
  </Disclosure>
</template>

<style scoped>
.fl__free { color: var(--accent); }
.fl__slots { color: var(--fg-dim); font-size: var(--fs-chrome); }
.fl__list { list-style: none; margin: 0; padding: 0; }
.fl__row { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.75rem; min-height: var(--tap-h); padding: 0 0.35rem 0 0.75rem; border-top: 1px solid var(--border-mute); }
.fl__state { flex: none; display: inline-flex; align-items: center; gap: 0.35rem; color: var(--accent); font-size: var(--fs-micro); }
.fl__state--wait { color: var(--fg-dim); }
.fl__title { flex: 1 1 8rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-mute); font-size: var(--fs-body-sm); }
.fl__row :deep(.btn--ghost) { color: var(--accent); }
@media (min-width: 640px) {
  /* Sigue en wrap: el título ya trunca, y el error o el ✓ de la acción bajan a su propia línea. */
  .fl__row { padding-left: 1rem; }
}
</style>
