<script setup lang="ts">
import { computed } from 'vue';
import FilterQueryInput from '@/ui/FilterQueryInput.vue';
import type { FilterFieldDef, FilterToken } from '@/ui/filter-query';
import {
  BLOCKED_VALUES,
  BRANCH_VALUES,
  PR_STATUS_VALUES,
  type BlockedValue,
  type BranchValue,
  type PrStatusValue,
  type TaskFilters,
} from '@/features/tasks/taskFilters';

// Barra de filtros del listado de tareas: un único input `campo:valor`, misma
// gramática que Ejecuciones/Logs (`FilterQueryInput` + `filter-query.ts`). No
// filtra nada: emite el estado y `TareasSection` aplica `filterTasks`.

const props = defineProps<{
  modelValue: TaskFilters;
  /** Statuses del proyecto, tal como los devuelve el provider. */
  statuses: string[];
  /** Repos vistos en las tareas cargadas, más los ya seleccionados. */
  repos: string[];
  /** Logins vistos en las tareas cargadas, más los ya seleccionados. */
  assignees: string[];
}>();

const emit = defineEmits<{ (e: 'update:modelValue', value: TaskFilters): void }>();

const filterFields = computed<FilterFieldDef[]>(() => [
  { key: 'status', hint: 'etapa del pipeline', values: props.statuses },
  { key: 'repo', hint: 'repo asociado', values: props.repos, free: true },
  { key: 'asignado', hint: 'quién la tiene asignada', values: props.assignees, free: true },
  { key: 'pr', hint: 'estado del PR', values: [...PR_STATUS_VALUES] },
  { key: 'rama', hint: 'branch linkeada', values: [...BRANCH_VALUES] },
  { key: 'bloqueada', hint: '¿tiene blockers sin resolver?', values: [...BLOCKED_VALUES] },
]);

const filterTokens = computed<FilterToken[]>({
  get: () => [
    ...props.modelValue.statuses.map((value) => ({ field: 'status', value })),
    ...props.modelValue.repos.map((value) => ({ field: 'repo', value })),
    ...props.modelValue.assignees.map((value) => ({ field: 'asignado', value })),
    ...props.modelValue.prStatus.map((value) => ({ field: 'pr', value })),
    ...props.modelValue.branch.map((value) => ({ field: 'rama', value })),
    ...props.modelValue.blocked.map((value) => ({ field: 'bloqueada', value })),
  ],
  set: (tokens) => {
    const of = (field: string) => tokens.filter((t) => t.field === field).map((t) => t.value);
    emit('update:modelValue', {
      statuses: of('status'),
      repos: of('repo'),
      assignees: of('asignado'),
      prStatus: of('pr') as PrStatusValue[],
      branch: of('rama') as BranchValue[],
      blocked: of('bloqueada') as BlockedValue[],
    });
  },
});
</script>

<template>
  <div class="filters">
    <FilterQueryInput
      v-model="filterTokens"
      :fields="filterFields"
      testid="task-filters"
      placeholder="Filtrar… escribí un campo (status, repo, asignado, pr, rama, bloqueada) y elegí su valor"
    />
  </div>
</template>

<style scoped>
.filters { margin-bottom: 0.85rem; }
</style>
