<script setup lang="ts">
import { computed } from 'vue';
import {
  EMPTY_TASK_FILTERS,
  hasActiveTaskFilters,
  type MergedFilter,
  type TaskFilters,
} from '@/features/tasks/taskFilters';

// Barra de chips del listado de tareas. No filtra nada: emite el estado y
// `TareasSection` aplica `filterTasks`. Misma gramática visual que la barra de
// ExecutionsSection (`.filter--chips`, `chip--active`, hint "N/M activos").

const props = defineProps<{
  modelValue: TaskFilters;
  /** Statuses del proyecto, tal como los devuelve el provider. */
  statuses: string[];
}>();

const emit = defineEmits<{ (e: 'update:modelValue', value: TaskFilters): void }>();

function patch(part: Partial<TaskFilters>) {
  emit('update:modelValue', { ...props.modelValue, ...part });
}

function isStatusActive(name: string): boolean {
  return props.modelValue.statuses.some((s) => s.toLowerCase() === name.toLowerCase());
}

function toggleStatus(name: string) {
  const current = props.modelValue.statuses;
  patch({
    statuses: isStatusActive(name)
      ? current.filter((s) => s.toLowerCase() !== name.toLowerCase())
      : [...current, name],
  });
}

// Un único control tri-estado: el ciclo arranca por "esconder" porque sacar de
// la vista lo ya mergeado es el motivo por el que existe el filtro.
const MERGED_CYCLE: MergedFilter[] = ['off', 'hide', 'only'];
const MERGED_LABEL: Record<MergedFilter, string> = {
  off: 'Mergeado: todas',
  hide: 'Mergeado: esconder',
  only: 'Mergeado: sólo',
};

function cycleMerged() {
  const i = MERGED_CYCLE.indexOf(props.modelValue.merged);
  patch({ merged: MERGED_CYCLE[(i + 1) % MERGED_CYCLE.length] });
}

const anyActive = computed(() => hasActiveTaskFilters(props.modelValue));
const statusHint = computed(() =>
  props.modelValue.statuses.length > 0
    ? `${props.modelValue.statuses.length}/${props.statuses.length} activos`
    : `todos (${props.statuses.length})`,
);
</script>

<template>
  <div class="filters" data-testid="task-filters">
    <div v-if="statuses.length > 0" class="filter filter--chips">
      <span class="filter-label">
        Status
        <span class="filter-hint">{{ statusHint }}</span>
      </span>
      <div class="chips">
        <button
          v-for="s in statuses"
          :key="s"
          type="button"
          class="chip chip--status"
          :class="{ 'chip--active': modelValue.statuses.length === 0 || isStatusActive(s) }"
          :aria-pressed="isStatusActive(s)"
          :data-testid="`task-filter-status-${s}`"
          @click="toggleStatus(s)"
        >{{ s }}</button>
      </div>
    </div>

    <div class="filter filter--chips">
      <span class="filter-label">Dev links</span>
      <div class="chips">
        <button
          type="button"
          class="chip"
          :class="{ 'chip--active': modelValue.hasPr }"
          :aria-pressed="modelValue.hasPr"
          data-testid="task-filter-has-pr"
          title="Sólo tareas con al menos un PR conocido"
          @click="patch({ hasPr: !modelValue.hasPr })"
        >Con PR</button>
        <button
          type="button"
          class="chip"
          :class="{ 'chip--active': modelValue.hasBranch }"
          :aria-pressed="modelValue.hasBranch"
          data-testid="task-filter-has-branch"
          title="Sólo tareas con rama remota linkeada"
          @click="patch({ hasBranch: !modelValue.hasBranch })"
        >Con branch</button>
        <button
          type="button"
          class="chip chip--tri"
          :class="{ 'chip--active': modelValue.merged !== 'off' }"
          :data-state="modelValue.merged"
          data-testid="task-filter-merged"
          title="Click para alternar: todas → esconder mergeadas → sólo mergeadas"
          @click="cycleMerged"
        >{{ MERGED_LABEL[modelValue.merged] }}</button>
        <button
          v-if="anyActive"
          type="button"
          class="chip chip--clear"
          data-testid="task-filter-clear"
          @click="emit('update:modelValue', { ...EMPTY_TASK_FILTERS })"
        >Limpiar</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.65rem 0.75rem;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 0.85rem;
}
.filter { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.filter-label { font-size: var(--fs-chrome); color: var(--fg-dim); }
.filter-hint { color: var(--fg-dimmer); margin-left: 0.25rem; font-size: var(--fs-micro); }

.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
.chip {
  padding: 0.15rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 999px;
  background: var(--panel);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  cursor: pointer;
}
.chip:hover { background: var(--panel-hi); }
.chip--active { font-weight: 600; background: var(--fg); color: var(--panel); border-color: var(--fg); }
.chip--status { color: var(--info); border-color: var(--info); background: var(--panel-hi); }
.chip--status.chip--active { background: var(--info); color: var(--panel); border-color: var(--info); }
/* El tri-estado se distingue por su texto, pero "sólo" invierte el sentido del
   filtro respecto de "esconder": el color lo hace legible de un vistazo. */
.chip--tri[data-state='only'] { background: var(--warn); color: var(--panel); border-color: var(--warn); }
.chip--clear { color: var(--fg-dim); }
</style>
