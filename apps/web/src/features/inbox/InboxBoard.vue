<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import InboxSection from '@/features/inbox/InboxSection.vue';
import InboxSummary from '@/features/inbox/InboxSummary.vue';
import InboxToolbar from '@/features/inbox/InboxToolbar.vue';
import RulesLegend from '@/features/inbox/RulesLegend.vue';
import TaskDetailDrawer from '@/features/inbox/TaskDetailDrawer.vue';
import { useInboxStore } from '@/features/inbox/store';
import { useTaskFocusStore } from '@/stores/taskFocus';

// La bandeja completa: resumen que filtra, los cuatro grupos en orden de
// urgencia (te necesita → falló → corriendo → en cola), estados de carga /
// vacío / error y la leyenda. Se suscribe al stream del runner mientras está
// montada.

const store = useInboxStore();

onMounted(() => store.start());
onBeforeUnmount(() => store.stop());

// Una tarea pedida desde afuera (una card del asistente): se abre y se trae a la vista.
const focusRequest = useTaskFocusStore();
watch(
  () => focusRequest.request,
  async () => {
    const ref = focusRequest.consume();
    if (!ref) return;
    store.focus(ref);
    await nextTick();
    document.getElementById(`card-${ref}`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  },
  { immediate: true },
);
</script>

<template>
  <div class="board">
    <InboxToolbar
      :projects="store.projects"
      :project="store.project"
      :stream="store.streamState"
      :loading="store.loading"
      @project="store.project = $event"
      @refresh="store.refresh()"
    />

    <InboxSummary :counts="store.counts" :active="store.groupFilter" @select="store.setGroupFilter($event)" />

    <div v-if="store.error" class="board__err" role="alert">
      <p>✕ {{ store.error }}</p>
      <p class="board__next">→ Revisá que el runner esté corriendo y que el token del server sea el correcto.</p>
      <button type="button" class="btn" @click="store.refresh()">Reintentar</button>
    </div>

    <p v-if="store.loading && !store.inbox" class="board__note">· cargando la bandeja…</p>

    <p v-else-if="store.inbox && store.total === 0 && !store.error" class="board__note board__note--ok">
      ✓ Todo en orden: nada te necesita, nada falló y nada espera.
    </p>

    <div v-else-if="store.inbox" class="board__grid">
      <InboxSection
        v-for="s in store.sections"
        :key="s.group"
        :class="{ 'board__full': store.groupFilter || s.group === 'need' || s.group === 'fail' }"
        :group="s.group"
        :items="s.items"
        :open-ref="store.openRef"
        :details="store.details"
        @toggle="store.toggle($event)"
        @reload="store.loadDetail($event)"
      />
    </div>

    <RulesLegend />

    <TaskDetailDrawer />
  </div>
</template>

<style scoped>
.board { display: flex; flex-direction: column; gap: 1rem; }
.board__grid { display: grid; gap: 1.5rem; }
/* 1100 habilita la segunda columna: corriendo y en cola, lado a lado. */
@media (min-width: 1100px) {
  .board__grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .board__full { grid-column: 1 / -1; }
}
.board__err { display: flex; flex-direction: column; gap: 0.35rem; align-items: flex-start; padding: 0.75rem; border: 1px solid var(--danger); border-radius: var(--radius); background: var(--red-bg); }
.board__err p { margin: 0; color: var(--danger); overflow-wrap: anywhere; }
.board__err .board__next { color: var(--info); font-size: var(--fs-body-sm); }
.board__err .btn { margin-top: 0.35rem; }
.board__note { margin: 0; color: var(--fg-dim); }
.board__note--ok { padding: 1rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); color: var(--accent); }
</style>
