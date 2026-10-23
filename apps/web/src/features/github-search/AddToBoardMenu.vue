<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  type AddOutcome,
  type AddRequest,
  type BoardProject,
  addTargets,
  columnOptions,
} from '@/features/github-search/board';

// «Agregar al board ▾» de un issue abierto que no está en el board: abre las columnas de su
// proyecto (la de entrada primero, «por defecto»); con más de un proyecto posible, por proyecto.
// Lo agrega la view (va por el runner, firmado con tu login); acá sólo se elige y se espera.

const props = defineProps<{
  issueRef: string;
  projects: readonly BoardProject[];
  add: (request: AddRequest) => Promise<AddOutcome>;
}>();
const emit = defineEmits<{ added: [status: string] }>();

const open = ref(false);
const pending = ref(false);
const failure = ref<string | null>(null);

const groups = computed(() =>
  addTargets(props.projects, props.issueRef).map((p) => ({ id: p.id, options: columnOptions(p.statuses) })),
);

async function choose(projectId: string, status: string | undefined): Promise<void> {
  pending.value = true;
  failure.value = null;
  const out = await props.add({ issue: props.issueRef, project_id: projectId, ...(status ? { status } : {}) });
  pending.value = false;
  if (out.ok) {
    open.value = false;
    emit('added', out.status);
  } else failure.value = out.message;
}
</script>

<template>
  <div class="atb">
    <button
      type="button"
      class="btn atb__toggle"
      :aria-expanded="open"
      :disabled="pending"
      data-test="add-toggle"
      @click="open = !open"
    >
      {{ pending ? '· agregando' : 'Agregar al board ▾' }}
    </button>
    <div v-if="open && !pending" class="atb__menu" role="menu" :aria-label="`Agregar ${issueRef} al board`">
      <template v-for="g in groups" :key="g.id">
        <p v-if="groups.length > 1" class="atb__project">{{ g.id }}</p>
        <button
          v-for="o in g.options"
          :key="`${g.id}:${o.label}`"
          type="button"
          role="menuitem"
          class="atb__option"
          data-test="add-column"
          @click="choose(g.id, o.status)"
        >
          {{ o.label }}
        </button>
      </template>
      <p v-if="!groups.length" class="atb__empty">El runner no tiene proyectos a los que agregarlo.</p>
    </div>
    <p v-if="failure" class="atb__fail" role="status" data-test="add-failure">✕ {{ failure }}</p>
  </div>
</template>

<style scoped>
.atb { display: flex; flex-direction: column; align-items: flex-start; gap: 0.35rem; min-width: 0; }
.atb__toggle { min-height: var(--tap-h); }
.atb__menu {
  display: flex;
  flex-direction: column;
  min-width: 12rem;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-alt);
  overflow: hidden;
}
.atb__project { margin: 0; padding: 0.4rem 0.75rem 0.1rem; color: var(--fg-dim); font-size: var(--fs-chrome); }
.atb__option {
  min-height: var(--tap-h);
  padding: 0 0.75rem;
  border: 0;
  border-top: 1px solid var(--border-mute);
  background: none;
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.atb__option:first-child { border-top: 0; }
.atb__option:hover { background: var(--panel-hi); }
.atb__option:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.atb__empty { margin: 0; padding: 0.5rem 0.75rem; color: var(--fg-dim); }
.atb__fail { margin: 0; color: var(--danger); font-size: var(--fs-body-sm); }
</style>
