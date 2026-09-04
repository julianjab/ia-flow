<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, ref, watch } from 'vue';
import type { Project, SourceRef, WhenCondition } from '@ia-flow/shared';
import { sourceKindLabel } from '@/features/projects/meta';
import { type SourceProjectField, fetchProjectFields } from '@/features/projects/sourceApi';
import { useProjectsStore } from '@/features/projects/store';
import { useToastStore } from '@/stores/toast';
import SourceFormSwitch from '@/features/projects/sources/SourceFormSwitch.vue';
import DaemonModeField from '@/features/projects/DaemonModeField.vue';
import ConcurrencyCapField from '@/ui/ConcurrencyCapField.vue';
import ConditionRowsEditor from '@/ui/ConditionRowsEditor.vue';
import type { ConditionRow } from '@/ui/condition-rows';

// Conversión propia y no importada de `features/rules`: una feature no puede
// importar de otra (ver CLAUDE.md de apps/web) aunque el DSL sea el mismo —
// `features/agents` tiene la misma duplicación por el mismo motivo.
function whenToRows(when: WhenCondition[] | null | undefined): ConditionRow[] {
  return (when ?? []).map((c, i) => ({
    field: c.field,
    op: c.op,
    value: c.value ?? '',
    logic: i === 0 ? 'and' : (c.logic ?? 'and'),
  }));
}
function rowsToWhen(rows: ConditionRow[]): WhenCondition[] | null {
  const when: WhenCondition[] = rows
    .filter((r) => r.field.trim())
    .map((r, i) => {
      const cond: WhenCondition = { field: r.field.trim(), op: r.op };
      if (r.op !== '$null' && r.op !== '$not_null') cond.value = r.value.trim();
      if (i > 0) cond.logic = r.logic ?? 'and';
      return cond;
    });
  return when.length ? when : null;
}
const BASE_WHEN_OPS = [
  { value: '=', label: '= igual' },
  { value: '!=', label: '!= distinto' },
  { value: '$contains', label: 'contiene' },
  { value: '$matches', label: 'matchea regex' },
  { value: '$null', label: 'es nulo' },
  { value: '$not_null', label: 'no es nulo' },
];

const props = defineProps<{ project: Project | null }>();

const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const draft = ref<SourceRef | null>(null);
// Raw settings.daemonMode: string o null (= heredar). Se guarda junto con la
// fuente porque son la misma decisión operativa: de dónde leo y cuándo miro.
const daemonMode = ref<string | null>(null);
// settings.maxConcurrentDispatches: tope de agentes corriendo a la vez en
// ESTE proyecto. null = heredar el default global de env
// (IA_FLOW_MAX_CONCURRENT_DISPATCHES). Vive junto al modo de disparo porque
// es la misma decisión operativa: cuándo miro y cuánto largo a la vez.
const maxConcurrent = ref<number | null>(null);
// settings.baseWhen: condiciones que el motor de reglas ANDea con el `when`
// de CADA regla de este proyecto (propias y globales) — ver
// ProjectSettingsSchema.baseWhen y packages/rules/src/match.ts. Vive junto a
// las otras dos porque son la misma pregunta operativa aplicada a un caso
// distinto: qué corre acá y bajo qué condición.
const baseWhenRows = ref<ConditionRow[]>([]);
const saving = ref(false);

// Declarado antes del `watch` de abajo a propósito: ese watch es `immediate`,
// así que corre durante el setup y leer acá un `const` declarado más abajo
// revienta con "cannot access before initialization" (TDZ).
const originalMaxConcurrent = computed(() => {
  const raw = props.project?.settings?.maxConcurrentDispatches;
  return typeof raw === 'number' && raw > 0 ? raw : null;
});

const originalBaseWhen = computed<WhenCondition[] | null>(() => {
  const raw = props.project?.settings?.baseWhen;
  return Array.isArray(raw) ? (raw as WhenCondition[]) : null;
});

watch(
  () => props.project?.id,
  () => {
    draft.value = props.project?.source
      ? { kind: props.project.source.kind, config: { ...(props.project.source.config ?? {}) } }
      : { kind: 'local', config: {} };
    const raw = props.project?.settings?.daemonMode;
    daemonMode.value = typeof raw === 'string' && raw ? raw : null;
    maxConcurrent.value = originalMaxConcurrent.value;
    baseWhenRows.value = whenToRows(originalBaseWhen.value);
  },
  { immediate: true },
);

const currentKind = computed(() => draft.value?.kind ?? 'local');

// Catálogo de campos de la fuente — el mismo que alimenta el editor de
// outcomes y el de condiciones `when`. Un form de fuente que pide un nombre de
// campo tiene que ofrecerlo desde acá y no pedirlo a mano: escrito a mano se
// escribe mal, y un campo que el board no tiene degrada en silencio.
//
// Sale del proyecto GUARDADO, así que hay dos casos sin catálogo: un proyecto
// recién creado (todavía no hay id) y una fuente cuya url se está editando
// ahora mismo (el catálogo es el del board viejo hasta guardar). Los dos caen
// al input libre — el form no bloquea nada por no tener la lista.
const sourceFields = ref<SourceProjectField[]>([]);

async function loadSourceFields() {
  if (!props.project) {
    sourceFields.value = [];
    return;
  }
  try {
    sourceFields.value = (await fetchProjectFields(props.project.id)).fields ?? [];
  } catch {
    sourceFields.value = [];
  }
}

watch(() => props.project?.id, loadSourceFields, { immediate: true });

// Field-by-field comparison to avoid false positives from key ordering.
const dirty = computed(() => {
  if (!props.project) return false;
  const original = props.project.source ?? null;
  if (!draft.value && !original) return false;
  if (!draft.value || !original) return true;
  if (draft.value.kind !== original.kind) return true;
  return JSON.stringify(draft.value.config ?? {}) !== JSON.stringify(original.config ?? {});
});

const originalDaemonMode = computed(() => {
  const raw = props.project?.settings?.daemonMode;
  return typeof raw === 'string' && raw ? raw : null;
});

const modeDirty = computed(() => daemonMode.value !== originalDaemonMode.value);

const capDirty = computed(() => maxConcurrent.value !== originalMaxConcurrent.value);

const baseWhenDirty = computed(
  () => JSON.stringify(rowsToWhen(baseWhenRows.value)) !== JSON.stringify(originalBaseWhen.value),
);

const anyDirty = computed(() => dirty.value || modeDirty.value || capDirty.value || baseWhenDirty.value);

async function save() {
  if (!props.project || !anyDirty.value) return;
  saving.value = true;
  try {
    await projectsStore.update(props.project.id, {
      source: draft.value,
      // null (no undefined) para limpiarlo: el PATCH mergea settings por key,
      // así que undefined dejaría el modo viejo persistido.
      settings: {
        daemonMode: daemonMode.value,
        maxConcurrentDispatches: maxConcurrent.value,
        baseWhen: rowsToWhen(baseWhenRows.value),
      },
    });
    toastStore.success('Provider actualizado');
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="ppt-section">
    <h2>Provider (manager)</h2>
    <p class="ppt-desc">
      De dónde se leen las tareas del proyecto. Cada fuente aporta su propia
      configuración; los agentes del proyecto se ejecutan igual sea cual sea.
    </p>

    <div class="ppt-status">
      <span class="ppt-status__label">Tipo actual:</span>
      <span :class="['ppt-badge', `ppt-badge--${currentKind}`]">{{ sourceKindLabel(currentKind) }}</span>
    </div>

    <SourceFormSwitch v-model="draft" :source-fields="sourceFields" />

    <DaemonModeField v-model="daemonMode" />

    <ConcurrencyCapField
      v-model="maxConcurrent"
      label="Máx. agentes en paralelo"
      inherit-label="Heredar el default global"
      hint="Los issues que no entran no se pierden: quedan en cola y se despachan al liberarse un slot."
    />

    <div class="ppt-basewhen">
      <span class="uc-label">Condiciones base</span>
      <p class="ppt-desc">
        Se ANDean con el <code>when</code> de CADA regla de este proyecto (propias y globales)
        antes de evaluarla — declará acá una condición como "labels != blocked" en vez de
        repetirla en cada regla.
      </p>
      <ConditionRowsEditor
        v-model="baseWhenRows"
        logic
        :ops="BASE_WHEN_OPS"
        field-placeholder="p. ej. labels"
        value-placeholder="valor"
        :op-takes-value="(op: string) => op !== '$null' && op !== '$not_null'"
      />
    </div>

    <div class="ppt-actions">
      <button class="ppt-btn ppt-btn--primary" :disabled="!anyDirty || saving" @click="save">
        {{ saving ? 'Guardando…' : 'Guardar' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.ppt-section {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1.25rem;
}
.ppt-section h2 { margin: 0 0 0.5rem; font-size: 1.15rem; }
.ppt-desc { margin: 0 0 1rem; color: var(--fg-dim); font-size: 0.9rem; }
.ppt-status { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
.ppt-status__label { font-size: 0.85rem; color: var(--fg-mute); }
.ppt-badge {
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 500;
  background: var(--panel-hi);
  color: var(--fg-mute);
}
.ppt-badge--github-projects,
.ppt-badge--github { background: var(--panel-hi); color: var(--accent); }
.ppt-basewhen { margin-top: 1rem; }
.ppt-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
.ppt-btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
  border: 1px solid transparent;
}
.ppt-btn--primary { background: var(--fg); color: var(--panel); }
.ppt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
