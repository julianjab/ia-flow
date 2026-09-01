<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AgentDefinition } from '@ia-flow/shared';
import AgentCard from '@/features/agents/AgentCard.vue';
import AgentEditorModal from '@/features/agents/AgentEditorModal.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import ScopeGroup from '@/ui/ScopeGroup.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useGlobalConfigStore } from '@/features/project-config/globalStore';
import { useProjectsStore } from '@/features/projects/store';
import { fetchAvailableAgents, fetchAvailableSystemPrompts } from '@/features/projects/availableApi';
import {
  createAgent as apiCreateAgent,
  deleteAgent as apiDeleteAgent,
  fetchAgentsReadOnly,
  updateAgent as apiUpdateAgent,
  type Scope,
} from '@/features/project-config/crudApi';
import type { SystemPromptDef } from '@ia-flow/shared';
import { useToastStore } from '@/stores/toast';

// Alfabético, y no por `position`: desde la migración 059 el orden de los
// agentes no decide NADA —quién corre y en qué orden lo deciden las reglas— así
// que ordenar por un campo que no se puede cambiar desde acá daría una lista
// con un orden aparentemente significativo que en realidad es arbitrario.
function byId(a: AgentDefinition, b: AgentDefinition): number {
  return a.id.localeCompare(b.id);
}


// scope='project' (default) → project detail view. Shows globals (read-only)
// + this project's own agents (editable). Writes always target the project.
// scope='global'  → General view. Only globals, editable.
const props = withDefaults(defineProps<{ scope?: 'project' | 'global' }>(), {
  scope: 'project',
});

const projectStore = useProjectConfigStore();
const globalStore = useGlobalConfigStore();
const projectsStore = useProjectsStore();
const configStore = computed(() => (props.scope === 'global' ? globalStore : projectStore));
const toastStore = useToastStore();

const isProject = computed(() => props.scope === 'project');

// When scope='project', we render two groups: read-only globals + editable
// project-owned. The union comes from /available-agents so the runtime
// overlay (project shadows global on id collision) is honoured.
const availableAgents = ref<AgentDefinition[]>([]);
// Sysprompt list handed to AgentEditorModal — overlay in project scope,
// globals only in global scope. Kept here so the modal doesn't need to know
// about the scope.
const availableSysprompts = ref<SystemPromptDef[]>([]);

// true when the current scope's agentRepo is a YamlAgentRepository (a fixed
// deploy roster, e.g. runners/subscriptions-pipeline) — writes there 400
// with "es de solo lectura...". Gates the add/edit/delete/reorder UI so the
// user sees that upfront instead of after a failed save.
const sourceReadOnly = ref(false);

async function loadReadOnly() {
  const scope = currentScope();
  if (!scope) {
    sourceReadOnly.value = false;
    return;
  }
  try {
    sourceReadOnly.value = await fetchAgentsReadOnly(scope);
  } catch {
    // Unknown state — default to NOT read-only so the UI doesn't lock
    // itself out over a transient fetch failure; the actual write (if
    // attempted) still fails loud with the real error.
    sourceReadOnly.value = false;
  }
}

// Gate para resolveAgentFromRoute: distingue "todavía no llegó el catálogo"
// (reintentar cuando llegue) de "llegó y el id no está" (avisar y volver a
// la lista). Sólo cubre el lado project-scope — el lado global depende del
// fetch de globalStore que dispara AppShell, no de este componente (ver
// catalogReady más abajo).
const projectCatalogLoaded = ref(false);

async function loadAvailable() {
  void loadReadOnly();
  if (!isProject.value) {
    availableAgents.value = [];
    availableSysprompts.value = globalStore.config?.systemPrompts ?? [];
    return;
  }
  // Reutilizamos esta misma instancia de componente al navegar entre
  // proyectos (misma route name `projects.detail`) — sin este reset, el
  // catálogo (y el flag) del proyecto anterior sigue "listo" mientras llega
  // el fetch nuevo, y resolveAgentFromRoute declararía inexistente un agente
  // del proyecto nuevo antes de tiempo.
  projectCatalogLoaded.value = false;
  const pid = projectsStore.activeProjectId;
  if (!pid) {
    availableAgents.value = [];
    availableSysprompts.value = [];
    projectCatalogLoaded.value = true;
    return;
  }
  try {
    const [agents, prompts] = await Promise.all([
      fetchAvailableAgents(pid),
      fetchAvailableSystemPrompts(pid),
    ]);
    availableAgents.value = agents;
    availableSysprompts.value = prompts;
    // Sólo el camino exitoso cuenta como "cargado" — si el fetch falló
    // (red intermitente, server caído), dejar el flag en false evita que
    // resolveAgentFromRoute declare "no existe" sobre un diagnóstico falso
    // y en cambio reintente cuando loadAvailable se vuelva a llamar.
    projectCatalogLoaded.value = true;
  } catch {
    availableAgents.value = [];
    availableSysprompts.value = [];
  }
}

onMounted(loadAvailable);
watch(() => [props.scope, projectsStore.activeProjectId], loadAvailable);
// Reload the overlay after any save so a new owned agent appears immediately.
watch(() => projectStore.config?.agents, () => { if (isProject.value) void loadAvailable(); });
// In global scope, keep the sysprompt list synced with the global store.
watch(() => globalStore.config?.systemPrompts, () => { if (!isProject.value) void loadAvailable(); });

const globalAgents = computed(() =>
  isProject.value
    ? availableAgents.value.filter((a) => a.projectId == null).sort(byId)
    : []
);
// Lista editable en este scope: los agentes propios del proyecto, o los
// globales cuando estamos en la vista General.
const ownAgents = computed(() =>
  (isProject.value
    ? availableAgents.value.filter((a) => a.projectId != null)
    : configStore.value.config?.agents ?? []
  )
    .slice()
    .sort(byId),
);
const totalCount = computed(() => globalAgents.value.length + ownAgents.value.length);

// ─── Ruta ↔ editor ──────────────────────────────────────────────────────
// Qué agente está abierto vive en la URL (:detailId — 'new' para alta),
// no en un ref local: así el detalle es deep-linkable y el sidebar de
// AppShell no se pierde (el editor ya no es un overlay position:fixed).
const route = useRoute();
const router = useRouter();

const agentModalOpen = ref(false);
const editingAgent = ref<AgentDefinition | null>(null);
// Derivado de en qué lista se encontró el agente, no de un flag manual: un
// agente global visto desde un proyecto es SIEMPRE read-only ahí (pertenece
// a General), sin importar si el agentRepo de este scope es escribible.
const editingReadOnly = ref(false);

function resolveAgentFromRoute() {
  const id = route.params.detailId as string | undefined;
  if (!id) {
    agentModalOpen.value = false;
    return;
  }
  if (id === 'new') {
    editingAgent.value = null;
    editingReadOnly.value = false;
    agentModalOpen.value = true;
    return;
  }
  const own = ownAgents.value.find((a) => a.id === id);
  if (own) {
    editingAgent.value = own;
    editingReadOnly.value = sourceReadOnly.value;
    agentModalOpen.value = true;
    return;
  }
  const global = isProject.value ? globalAgents.value.find((a) => a.id === id) : undefined;
  if (global) {
    editingAgent.value = global;
    editingReadOnly.value = true;
    agentModalOpen.value = true;
    return;
  }
  // Sin match — puede ser que el catálogo todavía no cargó (navegación
  // directa a la URL): el watcher de abajo reintenta apenas llega. Recién
  // si YA cargó y sigue sin match es un id real que no existe (borrado,
  // typo, back/forward tras un delete) — ahí sí hay que soltar el estado
  // viejo en vez de dejar la URL y el editor mostrando agentes distintos.
  if (!catalogReady.value) return;
  agentModalOpen.value = false;
  editingAgent.value = null;
  toastStore.error(`El agente '${id}' no existe`);
  pushAgentId(undefined);
}

const catalogReady = computed(() => (isProject.value ? projectCatalogLoaded.value : globalStore.config != null));

watch(() => route.params.detailId, resolveAgentFromRoute, { immediate: true });
watch([ownAgents, globalAgents, catalogReady], resolveAgentFromRoute);

function pushAgentId(agentId: string | undefined) {
  if (!route.name) return;
  const params = { ...route.params };
  if (agentId === undefined) delete params.detailId;
  else params.detailId = agentId;
  void router.push({ name: route.name, params });
}

function openNewAgent() {
  pushAgentId('new');
}
function openEditAgent(agent: AgentDefinition) {
  pushAgentId(agent.id);
}
function closeAgentModal() {
  pushAgentId(undefined);
}

function currentScope(): Scope | null {
  if (!isProject.value) return { kind: 'global' };
  const pid = projectsStore.activeProjectId;
  return pid ? { kind: 'project', projectId: pid } : null;
}

function agentExistsInScope(id: string): boolean {
  if (isProject.value) return ownAgents.value.some((a) => a.id === id);
  return (configStore.value.config?.agents ?? []).some((a) => a.id === id);
}

async function refresh() {
  await configStore.value.fetch();
  if (isProject.value) await loadAvailable();
}

async function handleAgentSave(agent: AgentDefinition) {
  const scope = currentScope();
  if (!scope) {
    toastStore.error('Selecciona un proyecto antes de guardar');
    return;
  }
  try {
    if (agentExistsInScope(agent.id)) {
      await apiUpdateAgent(scope, agent);
    } else {
      await apiCreateAgent(scope, agent);
    }
    await refresh();
    closeAgentModal();
    toastStore.success(`Agente '${agent.id}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  }
}

async function deleteAgent(agentId: string) {
  const scope = currentScope();
  if (!scope) return;
  try {
    await apiDeleteAgent(scope, agentId);
    await refresh();
    toastStore.success(`Agente '${agentId}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  }
}

interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}
const pendingConfirm = ref<PendingConfirm | null>(null);
function askConfirm(c: PendingConfirm) { pendingConfirm.value = c; }
async function runConfirm() {
  const c = pendingConfirm.value;
  if (!c) return;
  pendingConfirm.value = null;
  await c.onConfirm();
}
function cancelConfirm() { pendingConfirm.value = null; }

function confirmDelete(agent: AgentDefinition) {
  askConfirm({
    title: 'Eliminar agente',
    message: isProject.value
      ? `¿Eliminar '${agent.id}'? Solo se quita de este proyecto.`
      : `¿Eliminar el agente '${agent.id}'? Esta acción no se puede deshacer.`,
    confirmLabel: 'Eliminar',
    // Cierra el editor: se borra DESDE el detalle, así que dejarlo abierto
    // sobre un agente que ya no existe es peor que volver al listado.
    onConfirm: async () => {
      await deleteAgent(agent.id);
      closeAgentModal();
    },
  });
}
</script>

<template>
  <!-- El editor reemplaza la lista en vez de apilarse debajo — ver
       resolveAgentFromRoute: agentModalOpen ahora lo maneja la URL. -->
  <section v-if="!agentModalOpen" class="settings-section">
    <div class="section-header">
      <div class="section-head-text">
        <h2>Agentes</h2>
        <p class="section-desc">
          <template v-if="isProject">
            Agentes disponibles para este proyecto. Los globales se muestran para referencia;
            para modificarlos, edítalos desde General. <b>Cuándo</b> corre cada uno lo decide una
            regla, en Pipeline.
          </template>
          <template v-else>
            Biblioteca de definiciones reutilizables: cada agente tiene un id, provider,
            prompt, tools y salidas. <b>Cuándo</b> corre cada uno no se define acá — lo decide
            una regla, en Pipeline.
          </template>
        </p>
      </div>
      <div class="section-head-actions">
        <button
          v-if="!sourceReadOnly"
          type="button"
          class="btn btn--primary"
          @click="openNewAgent"
        >
          + Agregar agente
        </button>
      </div>
    </div>

    <p v-if="sourceReadOnly" class="readonly-banner">
      Este scope viene de un roster fijo (YAML de deploy) — es de solo lectura desde acá.
      Para modificarlo, editá el archivo YAML del deploy y reiniciá el proceso.
    </p>

    <p v-if="totalCount" class="order-hint">
      Un agente no corre por estar en esta lista: corre cuando una <b>regla</b> lo nombra.
      Un agente que ninguna regla nombra nunca se ejecuta.
    </p>

    <div v-if="!totalCount" class="repos-empty">
      <template v-if="isProject">
        No hay agentes disponibles. Crea uno con "+ Agregar agente del proyecto" o define
        globales desde General.
      </template>
      <template v-else>
        No hay agentes definidos. Haz clic en "+ Agregar agente" para crear el primero.
      </template>
    </div>

    <!-- Los dos grupos usan la MISMA pieza que Pipeline, Acciones, Tools y
         System Prompts (`ScopeGroup`): "qué puedo tocar acá" es la primera
         pregunta de las cinco pantallas, y cuando cada una la contestaba con su
         propio `<h3>` la respuesta se veía distinta en cada una. -->
    <ScopeGroup
      v-if="ownAgents.length"
      variant="own"
      :label="isProject ? 'De este proyecto' : 'De este ámbito'"
      :count="ownAgents.length"
    >
      <div class="agent-list" data-kbd-list="agents">
        <AgentCard
          v-for="agent in ownAgents"
          :key="`own-${agent.id}`"
          :agent="agent"
          :readonly="sourceReadOnly"
          data-kbd-item
          tabindex="0"
          @edit="openEditAgent(agent)"
        />
      </div>
    </ScopeGroup>

    <ScopeGroup
      v-if="isProject && globalAgents.length"
      variant="inherited"
      label="Globales"
      :count="globalAgents.length"
      edit-hint="General → Agentes"
    >
      <div class="agent-list">
        <!-- Sin `order`: ese número era la posición dentro de ESTE listado, y
             desde la migración 059 el orden de los agentes no decide nada —
             quién corre y en qué orden lo decide una regla. -->
        <AgentCard
          v-for="agent in globalAgents"
          :key="`global-${agent.id}`"
          :agent="agent"
          readonly
          @edit="openEditAgent(agent)"
        />
      </div>
    </ScopeGroup>
  </section>

  <AgentEditorModal
    :open="agentModalOpen"
    :agent="editingAgent"
    :scope="props.scope"
    :readonly="editingReadOnly"
    :available-system-prompts="availableSysprompts"
    @close="closeAgentModal"
    @save="handleAgentSave"
    @delete="confirmDelete"
  />

  <ConfirmDialog
    :open="pendingConfirm != null"
    :title="pendingConfirm?.title"
    :message="pendingConfirm?.message ?? ''"
    :confirm-label="pendingConfirm?.confirmLabel"
    danger
    @confirm="runConfirm"
    @cancel="cancelConfirm"
  />
</template>

<style scoped>


.repos-empty { font-size: 0.875rem; color: var(--fg-dim); padding: 0.5rem 0; }

/* El encabezado de cada grupo lo pone `ScopeGroup` — la misma pieza que
   Pipeline, Acciones, Tools y System Prompts. */
.agent-list { display: flex; flex-direction: column; gap: 0.3rem; }
.order-hint {
  margin: 0 0 0.6rem;
  font-size: var(--fs-body-sm);
  color: var(--fg-dim);
}
.readonly-banner {
  margin: 0 0 0.6rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--warn);
  border-radius: 6px;
  background: var(--yellow-bg);
  color: var(--warn);
  font-size: var(--fs-body-sm);
}

@media (max-width: 768px) {
  /* El boton de agregar quedaba 14px afuera: es un flex sin `wrap` con el
     texto de la seccion al lado. Se apila. */
  .section-header { flex-wrap: wrap; }
  .section-header > * { min-width: 0; }
}

@media (max-width: 640px) {
  .settings-section { padding: 0.75rem; }
  /* Ya apilado por la regla de arriba, el boton queda solo en su fila con
     medio ancho de aire al lado. Que la ocupe entera: es la unica accion de
     la pantalla y asi tiene el area de toque que le corresponde. */
  .section-head-actions .btn { width: 100%; }
}
</style>