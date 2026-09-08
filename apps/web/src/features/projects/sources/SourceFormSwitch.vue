<script setup lang="ts">
import type { SourceRef } from '@ia-flow/shared';
import { computed, onMounted, ref } from 'vue';
import GitHubIssuesSourceForm from './GitHubIssuesSourceForm.vue';
import GitHubSourceForm from './GitHubSourceForm.vue';
import JsonSourceForm from './JsonSourceForm.vue';
import LocalSourceForm from './LocalSourceForm.vue';
import { FALLBACK_META, loadProjectsMeta, sourceKindLabel } from '@/features/projects/meta';
import type { SourceProjectField } from '@/features/projects/sourceApi';

// Registry of source kinds → their per-config form component.
// Adding a new source with a dedicated form: add an entry here. Without an
// entry, JsonSourceForm renders a textarea so the source is still usable.
const KIND_FORMS: Record<string, unknown> = {
  'github-projects': GitHubSourceForm,
  // Alias deprecados de 'github-projects': un proyecto guardado con el kind
  // viejo tiene que seguir abriendo el mismo form (que ya trae owner/repo/
  // anchorLabel opcionales), no caer al textarea JSON.
  github: GitHubSourceForm,
  'github-hybrid': GitHubSourceForm,
  local: LocalSourceForm,
  'github-issues': GitHubIssuesSourceForm,
};

const props = defineProps<{
  modelValue: SourceRef | null | undefined;
  /** Catálogo de campos de la fuente ya guardada — el mismo que consumen el
   *  editor de outcomes y el de `when`. Vacío = sin catálogo (proyecto nuevo,
   *  o fetch fallido): los forms caen a input libre. */
  sourceFields?: SourceProjectField[];
}>();
const emit = defineEmits<{ 'update:modelValue': [value: SourceRef | null] }>();

// Lo que el server tiene registrado; el fallback compilado sólo aplica si la
// llamada falla, así una fuente nueva del server aparece sin release del front.
const kinds = ref<string[]>([...FALLBACK_META.sourceKinds]);

onMounted(async () => {
  kinds.value = (await loadProjectsMeta()).sourceKinds;
});

const kind = computed({
  get: () => props.modelValue?.kind ?? 'local',
  set: (v: string) => emit('update:modelValue', { kind: v, config: {} }),
});

const config = computed(() => (props.modelValue?.config ?? {}) as Record<string, unknown>);

function updateConfig(next: Record<string, unknown>) {
  emit('update:modelValue', { kind: kind.value, config: next });
}

const currentForm = computed(() => KIND_FORMS[kind.value] ?? JsonSourceForm);

// Sólo el form de Projects v2 pide el catálogo. Bindearlo a todos dejaría un
// atributo suelto en el DOM de los que no lo declaran como prop.
const formProps = computed(() =>
  currentForm.value === GitHubSourceForm ? { sourceFields: props.sourceFields ?? [] } : {},
);
</script>

<template>
  <div class="sfs">
    <label class="ff-row">
      <span class="uc-label">Fuente</span>
      <select v-model="kind" class="ff-field">
        <option v-for="k in kinds" :key="k" :value="k">{{ sourceKindLabel(k) }}</option>
        <!-- If the project already has a kind not in the supported list,
             surface it so the user can see and re-pick — but they can't
             pick it back once switched away. -->
        <option
          v-if="modelValue?.kind && !kinds.includes(modelValue.kind)"
          :value="modelValue.kind"
        >{{ sourceKindLabel(modelValue.kind) }} (personalizado)</option>
      </select>
    </label>
    <component
      :is="currentForm"
      :model-value="config"
      v-bind="formProps"
      @update:model-value="updateConfig"
    />
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
/* El campo es del kit (`ff-row` + `uc-label` + `ff-field`); acá queda sólo el
   ritmo entre el selector y el formulario del kind elegido. Tenía su propia
   copia con prefijo `.sfs-` y un radio de 6px. */
.sfs { display: flex; flex-direction: column; gap: 0.75rem; }
</style>
