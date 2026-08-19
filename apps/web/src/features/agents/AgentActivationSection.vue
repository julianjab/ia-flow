<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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
  allowBlocked: boolean
}>()

const emit = defineEmits<{
  (e: 'update:repoName', value: string | null): void
  (e: 'update:statusName', value: string | null): void
  (e: 'update:when', value: WhenCondition[]): void
  (e: 'update:enabled', value: boolean): void
  (e: 'update:allowBlocked', value: boolean): void
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

// Un criterio se muestra sólo si se puede definir en este contexto. Un select
// deshabilitado o con una única opción "Todos" no comunica nada: ocupa lugar
// y sugiere que hay algo que elegir cuando no lo hay. La excepción es tener ya
// un valor guardado — ahí el control se muestra siempre, porque si no el
// usuario no tendría forma de cambiarlo ni de limpiarlo.
const canSetRepo = computed(() => props.scope === 'project' && repoOptions.value.length > 0)
const showRepo = computed(() => canSetRepo.value || !!props.repoName)

const canSetStatus = computed(() => statusOptions.value.length > 0)
const showStatus = computed(() => canSetStatus.value || !!props.statusName)

// Cuando ningún criterio de scope es definible, una sola línea lo explica en
// lugar de dejar dos selects muertos.
const scopeNote = computed(() => {
  if (showRepo.value || showStatus.value) return null
  if (props.scope === 'global') {
    return 'Agente global: repo y status viven dentro de un proyecto, así que acá sólo se definen condiciones.'
  }
  return 'Este proyecto todavía no expone repos ni statuses — revisá la fuente del proyecto.'
})
</script>

<template>
  <div class="aas">
    <span class="uc-label aas-title">Activación</span>
    <p class="aas-hint">
      Corre el primer agente habilitado que cumpla todos los criterios. Un campo vacío
      significa "sin restricción".
      <span class="aas-scope">{{
        scope === 'global' ? 'Global — cualquier proyecto' : (projectName ?? 'Sin proyecto')
      }}</span>
    </p>

    <p v-if="scopeNote" class="aas-hint aas-note">{{ scopeNote }}</p>

    <!-- ── Repo ─────────────────────────────────────────────────────── -->
    <div v-if="showRepo" class="aas-field">
      <label class="uc-label" for="aas-repo">Repo</label>
      <select
        id="aas-repo"
        class="aas-select"
        :value="repoName ?? ''"
        @change="emit('update:repoName', ($event.target as HTMLSelectElement).value || null)"
      >
        <option value="">Todos los repos</option>
        <option v-for="r in repoOptions" :key="r" :value="r">{{ r }}</option>
      </select>
    </div>

    <!-- ── Status ───────────────────────────────────────────────────── -->
    <div v-if="showStatus" class="aas-field">
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

    <!-- ── Allow blocked ────────────────────────────────────────────── -->
    <div class="aas-field">
      <label class="aas-toggle">
        <input
          id="aas-allow-blocked"
          type="checkbox"
          :checked="allowBlocked"
          @change="emit('update:allowBlocked', ($event.target as HTMLInputElement).checked)"
        />
        <span class="uc-label">Permitir procesar tareas bloqueadas</span>
      </label>
      <p class="aas-hint">
        Cuando está apagado (default), el engine ignora tareas cuyo issue tenga bloqueadores sin
        finalizar. Encendé esto para agentes como el de <code>Refine</code>, donde tiene sentido
        trabajar sobre un épic bloqueado.
      </p>
    </div>

    <!-- ── Enabled ──────────────────────────────────────────────────── -->
    <label class="aas-toggle">
      <input
        id="aas-enabled"
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

.aas-scope {
  color: var(--fg-mute);
}
.aas-scope::before {
  content: ' · ';
}

.aas-note {
  color: var(--fg-mute);
  border-left: 2px solid var(--border);
  padding-left: 0.6ch;
}

.aas-hint code {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  background: var(--panel-hi);
  padding: 0 0.25rem;
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
