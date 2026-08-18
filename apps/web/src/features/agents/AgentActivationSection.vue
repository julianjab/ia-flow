<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { WhenCondition } from '@ia-flow/shared'
import WhenConditionsEditor from '@/features/agents/WhenConditionsEditor.vue'
import type { ProjectField } from '@/features/agents/outcomes-serialization'
import { getRepoMappings } from '@/features/repos/api'
import { fetchProjectFields, fetchProjectStatuses } from '@/features/projects/sourceApi'

// Los 4 criterios que el engine evalúa en orden (project → repo → status →
// when) para decidir si este agente es candidato para un issue — ver
// AgentActivationSchema en packages/shared/src/schemas.ts. `projectId` es
// read-only aquí: lo decide el scope donde se abrió el editor, no un campo
// de este form.

const props = defineProps<{
  scope: 'project' | 'global'
  projectId: string | null
  projectName: string | null
  repoName: string | null
  statusName: string | null
  when: WhenCondition[]
  enabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update:repoName', value: string | null): void
  (e: 'update:statusName', value: string | null): void
  (e: 'update:when', value: WhenCondition[]): void
  (e: 'update:enabled', value: boolean): void
}>()

const repoOptions = ref<string[]>([])
const statusOptions = ref<string[]>([])
const projectFields = ref<ProjectField[]>([])

async function loadScopedData() {
  if (props.scope !== 'project' || !props.projectId) {
    repoOptions.value = []
    statusOptions.value = []
    projectFields.value = []
    return
  }
  try {
    const repos = await getRepoMappings(props.projectId)
    repoOptions.value = repos.map((r) => r.name).sort()
  } catch {
    repoOptions.value = []
  }
  try {
    const res = await fetchProjectStatuses(props.projectId)
    statusOptions.value = (res.statuses ?? []).map((s) => s.name)
  } catch {
    statusOptions.value = []
  }
  try {
    const res = await fetchProjectFields(props.projectId)
    projectFields.value = (res.fields ?? []).map((f) => ({
      name: f.name,
      dataType: f.dataType,
      options: f.options ?? [],
    }))
  } catch {
    projectFields.value = []
  }
}

onMounted(loadScopedData)
watch(() => [props.scope, props.projectId], loadScopedData)
</script>

<template>
  <div class="aas">
    <span class="uc-label aas-title">Activación</span>
    <p class="aas-hint">
      Corre el primer agente habilitado que cumpla los cuatro criterios (proyecto → repo →
      status → condiciones). Un campo vacío significa "sin restricción".
    </p>

    <!-- ── Proyecto (read-only) ─────────────────────────────────────── -->
    <div class="aas-field">
      <label class="uc-label" for="aas-project">Proyecto</label>
      <div id="aas-project" class="aas-readonly">
        {{ scope === 'global' ? 'Global — cualquier proyecto' : (projectName ?? '—') }}
      </div>
    </div>

    <!-- ── Repo ─────────────────────────────────────────────────────── -->
    <div class="aas-field">
      <label class="uc-label" for="aas-repo">Repo</label>
      <select
        id="aas-repo"
        class="aas-select"
        :value="repoName ?? ''"
        :disabled="scope === 'global'"
        @change="emit('update:repoName', ($event.target as HTMLSelectElement).value || null)"
      >
        <option value="">Todos los repos</option>
        <option v-for="r in repoOptions" :key="r" :value="r">{{ r }}</option>
      </select>
      <span v-if="scope === 'global'" class="aas-hint">
        Un agente global no puede fijar un repo — repos viven dentro de un proyecto.
      </span>
    </div>

    <!-- ── Status ───────────────────────────────────────────────────── -->
    <div class="aas-field">
      <label class="uc-label" for="aas-status">Status</label>
      <select
        id="aas-status"
        class="aas-select"
        :value="statusName ?? ''"
        @change="emit('update:statusName', ($event.target as HTMLSelectElement).value || null)"
      >
        <option value="">Cualquier status</option>
        <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
      </select>
    </div>

    <!-- ── Condiciones (when) ──────────────────────────────────────── -->
    <div class="aas-field">
      <span class="uc-label">Condiciones</span>
      <WhenConditionsEditor
        :model-value="when"
        :project-fields="projectFields"
        :status-options="statusOptions"
        @update:model-value="emit('update:when', $event)"
      />
    </div>

    <!-- ── Enabled ──────────────────────────────────────────────────── -->
    <label class="aas-toggle">
      <input
        type="checkbox"
        :checked="enabled"
        @change="emit('update:enabled', ($event.target as HTMLInputElement).checked)"
      />
      <span class="uc-label">Habilitado</span>
    </label>
  </div>
</template>

<style scoped>
.aas {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.6rem;
  border: 1px solid var(--border);
  background: var(--panel-alt);
}
.aas-title { color: var(--fg); }
.aas-hint {
  margin: 0;
  font-size: var(--fs-body-sm);
  color: var(--fg-dim);
  line-height: 1.4;
}

.aas-field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.aas-readonly {
  height: var(--row-h);
  line-height: var(--row-h);
  padding: 0 0.5ch;
  color: var(--fg-mute);
  background: var(--panel);
  border: 1px solid var(--border-mute);
  font-size: var(--fs-body-sm);
}

.aas-select {
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.aas-select:disabled {
  background: var(--panel-alt);
  color: var(--fg-dimmer);
  cursor: not-allowed;
}

.aas-toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  width: fit-content;
}
.aas-toggle input {
  accent-color: var(--accent);
}
</style>
