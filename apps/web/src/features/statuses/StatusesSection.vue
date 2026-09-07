<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, onMounted, ref, watch } from 'vue';
import type { StatusConfig } from '@ia-flow/shared';
import StatusConfigModal from '@/features/statuses/StatusConfigModal.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProjectsStore } from '@/features/projects/store';
import { useToastStore } from '@/stores/toast';
import ExecutionStatusLine from '@/components/ExecutionStatusLine.vue';
import type { TaskRunSummary } from '@ia-flow/shared';
import {
  fetchProjectItems,
  fetchProjectStatuses,
  type SourceItem,
  type StatusOption,
} from '@/features/projects/sourceApi';
import { fetchBlockersBatch, fetchTaskRunSummaries } from '@/features/tasks/api';
import {
  createStatus as apiCreateStatus,
  deleteStatus as apiDeleteStatus,
  updateStatus as apiUpdateStatus,
} from '@/features/statuses/statusesApi';

const projectConfigStore = useProjectConfigStore();
const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const statusModalOpen = ref(false);
const editingStatus = ref<StatusConfig | null>(null);
const sourceStatuses = ref<StatusOption[]>([]);
const statusNameLocked = ref(false);

// ─── El board ────────────────────────────────────────────────────────────
//
// Una columna por vez, no un carrusel horizontal: en un teléfono un board de
// 5 columnas se lee scrolleando de lado y perdiendo el hilo. Los status son
// chips con su contador y la columna elegida se despliega abajo con la misma
// fila densa del listado de Tareas.
const items = ref<SourceItem[]>([]);
const runsByTask = ref<Record<string, TaskRunSummary>>({});
const runsKnown = ref(false);
const blockersByTask = ref<Record<string, Array<{ id: string }>>>({});
const boardLoading = ref(false);
const boardError = ref('');
/** Columna abierta. `null` = la primera con tareas. */
const selectedStatus = ref<string | null>(null);

async function loadBoard() {
  const pid = projectsStore.activeProjectId;
  runsKnown.value = false;
  runsByTask.value = {};
  blockersByTask.value = {};
  if (!pid) {
    items.value = [];
    return;
  }
  boardLoading.value = true;
  boardError.value = '';
  try {
    const res = await fetchProjectItems(pid);
    if (projectsStore.activeProjectId !== pid) return;
    if (res.error) {
      boardError.value = res.error;
      return;
    }
    items.value = res.items ?? [];
    const [summaries, blockers] = await Promise.allSettled([
      fetchTaskRunSummaries(pid),
      fetchBlockersBatch(pid, items.value.map((i) => i.id)),
    ]);
    if (projectsStore.activeProjectId !== pid) return;
    if (summaries.status === 'fulfilled') {
      const byTask: Record<string, TaskRunSummary> = {};
      for (const s of summaries.value) byTask[s.taskId] = s;
      runsByTask.value = byTask;
      runsKnown.value = true;
    }
    if (blockers.status === 'fulfilled') blockersByTask.value = blockers.value;
  } catch (e) {
    if (projectsStore.activeProjectId === pid) boardError.value = extractErrorMessage(e);
  } finally {
    if (projectsStore.activeProjectId === pid) boardLoading.value = false;
  }
}

/** Cuántas tareas hay en cada status, con el nombre tal como lo devuelve la
 *  fuente (la comparación es case-insensitive: los boards de GitHub no
 *  garantizan capitalización estable). */
const countByStatus = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const item of items.value) {
    const key = (item.status ?? '').toLowerCase();
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
});

const activeStatus = computed(() => {
  if (selectedStatus.value) return selectedStatus.value;
  const first = allStatuses.value.find(({ name }) => countByStatus.value[name.toLowerCase()]);
  return first?.name ?? allStatuses.value[0]?.name ?? null;
});

const columnItems = computed<SourceItem[]>(() => {
  const status = (activeStatus.value ?? '').toLowerCase();
  return items.value.filter((i) => (i.status ?? '').toLowerCase() === status);
});

/**
 * Cuántas de esta columna no tiene quién las mueva: nunca corrieron y no
 * están bloqueadas. Es el número que dice si una etapa está estancada, y por
 * eso va en `--warn` al lado del contador total.
 *
 * Sólo se muestra cuando el agregado llegó: sin él serían todas.
 */
const stalledInColumn = computed(() =>
  runsKnown.value
    ? columnItems.value.filter(
        (i) => !runsByTask.value[i.id] && !(blockersByTask.value[i.id]?.length ?? 0),
      ).length
    : null,
);

function issueNumberOf(item: SourceItem): number | undefined {
  return item.meta?.issueNumber as number | undefined;
}
function issueUrlOf(item: SourceItem): string | undefined {
  return item.meta?.issueUrl as string | undefined;
}

// Status names come 100% from the project's source. The server-side factory
// picks the right ProjectSource per project kind (github, local, ...); the
// UI has no kind-specific branches. Per-status config (position, etc.) is
// looked up from the DB by name. Qué corre en cada status NO se resuelve acá:
// desde la migración 059 lo decide una regla, y la respuesta vive en Pipeline.
/** La config por status, indexada por nombre en minúsculas — el board la
 *  necesita para abrir el modal de la columna abierta. */
const statusConfigByName = computed(
  () =>
    new Map(
      (projectConfigStore.config?.statuses ?? []).map((s) => [s.name.toLowerCase(), s]),
    ),
);

const allStatuses = computed(() => {
  const configMap = new Map(
    (projectConfigStore.config?.statuses ?? []).map((s) => [s.name.toLowerCase(), s]),
  );
  return sourceStatuses.value.map(({ name }) => ({
    name,
    config: configMap.get(name.toLowerCase()) ?? null,
  }));
});

function openConfigureStatus(name: string, config: StatusConfig | null) {
  editingStatus.value = config ?? ({ name } as StatusConfig);
  statusNameLocked.value = true;
  statusModalOpen.value = true;
}

/** Sólo se puede borrar lo que ESTE proyecto configuró: el status en sí lo
 *  define la fuente y no es nuestro para borrar. */
const editingIsConfigured = computed(() =>
  (projectConfigStore.config?.statuses ?? []).some(
    (s) => s.name.toLowerCase() === (editingStatus.value?.name ?? '').toLowerCase(),
  ),
);

function askDeleteStatus(statusName: string) {
  askConfirm({
    title: 'Eliminar configuración de status',
    message: `¿Eliminar la configuración del status '${statusName}'?`,
    confirmLabel: 'Eliminar',
    onConfirm: async () => {
      await deleteStatus(statusName);
      statusModalOpen.value = false;
    },
  });
}

async function deleteStatus(statusName: string) {
  const pid = projectsStore.activeProjectId;
  if (!pid) return;
  try {
    await apiDeleteStatus(pid, statusName);
    await projectConfigStore.fetch();
    toastStore.success(`Status '${statusName}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  }
}

async function handleStatusSave(status: StatusConfig) {
  const pid = projectsStore.activeProjectId;
  if (!pid) {
    toastStore.error('Selecciona un proyecto antes de guardar');
    return;
  }
  const exists = (projectConfigStore.config?.statuses ?? []).some(
    (s) => s.name.toLowerCase() === status.name.toLowerCase(),
  );
  try {
    if (exists) {
      await apiUpdateStatus(pid, status);
    } else {
      await apiCreateStatus(pid, status);
    }
    await projectConfigStore.fetch();
    statusModalOpen.value = false;
    toastStore.success(`Status '${status.name}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  }
}

async function loadSourceStatuses() {
  const pid = projectsStore.activeProjectId;
  if (!pid) {
    sourceStatuses.value = [];
    return;
  }
  try {
    const res = await fetchProjectStatuses(pid);
    sourceStatuses.value = res.statuses ?? [];
  } catch {
    sourceStatuses.value = [];
  }
}

onMounted(() => {
  void loadSourceStatuses();
  void loadBoard();
});

// Reload source-derived data whenever the user switches projects.
watch(() => projectsStore.activeProjectId, () => {
  selectedStatus.value = null;
  void loadSourceStatuses();
  void loadBoard();
});

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
</script>

<template>
  <section class="settings-section">
    <h2>Statuses</h2>
    <p class="section-desc">
      Las etapas del proyecto, tal como las devuelve la fuente. Acá se les da nombre y orden
      para mostrarlas; <b>qué corre en cada una lo deciden las reglas</b>, en Pipeline.
    </p>

    <div v-if="!allStatuses.length" class="repos-empty">
      No hay statuses aún. Crea una tarea primero.
    </div>

    <template v-else>
      <!-- Una columna por vez. El chip activo va en video inverso, como toda
           selección del sistema — nunca un outline de color. -->
      <div class="bd-chips">
        <button
          v-for="{ name } in allStatuses"
          :key="name"
          type="button"
          class="bd-chip"
          :class="{ 'is-active': activeStatus?.toLowerCase() === name.toLowerCase() }"
          @click="selectedStatus = name"
        >
          {{ name }}
          <span class="bd-chip-count">{{ countByStatus[name.toLowerCase()] ?? 0 }}</span>
        </button>
      </div>

      <div v-if="boardError" class="bd-error">
        <p class="bd-error-line"><span class="bd-glyph">✕</span>{{ boardError }}</p>
        <p class="bd-error-fix"><span class="bd-glyph">→</span>Revisá el provider del proyecto y volvé a intentar.</p>
      </div>

      <template v-else-if="activeStatus">
        <div class="bd-col-head">
          <span class="bd-col-name">{{ activeStatus }}</span>
          <span class="bd-col-count">{{ columnItems.length }}</span>
          <span class="bd-col-spacer"></span>
          <!-- El número de atención: cuántas no tiene quién las mueva. Sólo
               cuando el agregado llegó — sin él serían todas. -->
          <span v-if="stalledInColumn" class="bd-col-stalled">{{ stalledInColumn }} sin correr</span>
          <button
            type="button"
            class="btn btn--ghost bd-config"
            @click="openConfigureStatus(activeStatus, statusConfigByName.get(activeStatus.toLowerCase()) ?? null)"
          >Configurar status</button>
        </div>

        <p v-if="boardLoading && !columnItems.length" class="repos-empty">Cargando…</p>
        <p v-else-if="!columnItems.length" class="repos-empty">
          Ninguna tarea en {{ activeStatus }}.
        </p>

        <ul v-else class="bd-list">
          <li v-for="item in columnItems" :key="item.id" class="bd-row">
            <span class="bd-row-glyph">
              <ExecutionStatusLine
                class="bd-glyph-only"
                :execution="runsByTask[item.id]?.last ?? null"
                :attempts="runsByTask[item.id]?.attempts"
                :blocked="(blockersByTask[item.id]?.length ?? 0) > 0"
                :runs-known="runsKnown"
              />
            </span>
            <div class="bd-row-body">
              <p class="bd-row-title">
                {{ item.title }}
                <a
                  v-if="issueNumberOf(item) && issueUrlOf(item)"
                  class="bd-row-issue"
                  :href="issueUrlOf(item)"
                  target="_blank"
                  rel="noopener"
                >#{{ issueNumberOf(item) }}</a>
              </p>
              <!-- La MISMA línea de estado que el listado: una sola
                   implementación del vocabulario, o cada pantalla dice algo
                   distinto sobre el mismo hecho. -->
              <ExecutionStatusLine
                :execution="runsByTask[item.id]?.last ?? null"
                :attempts="runsByTask[item.id]?.attempts"
                :blocked="(blockersByTask[item.id]?.length ?? 0) > 0"
                :runs-known="runsKnown"
              />
            </div>
          </li>
        </ul>

        <p class="bd-note">
          Arrastrar entre columnas no existe acá: el status se cambia desde el detalle de la tarea.
          <router-link
            :to="{
              name: 'projects.detail',
              params: { id: projectsStore.activeProjectId, tab: 'pipeline' },
            }"
            class="bd-rules-link"
          >Ver qué corre en {{ activeStatus }} →</router-link>
        </p>
      </template>
    </template>
  </section>

  <StatusConfigModal
    :open="statusModalOpen"
    :status-config="editingStatus"
    :status-options="sourceStatuses.map((s) => s.name)"
    :name-locked="statusNameLocked"
    :deletable="editingIsConfigured"
    @close="statusModalOpen = false"
    @save="handleStatusSave"
    @delete="askDeleteStatus"
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
/* ─── El board ──────────────────────────────────────────────────────────── */
.bd-chips {
  display: flex;
  gap: 0.3rem;
  overflow-x: auto;
  padding-bottom: 0.2rem;
}
.bd-chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  height: calc(var(--row-h) * 1.15);
  padding: 0 0.6rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius-sm);
  background: var(--panel-hi);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  white-space: nowrap;
  cursor: pointer;
}
/* Selección en video inverso, nunca outline de color. */
.bd-chip.is-active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--panel);
}
.bd-chip-count { color: inherit; opacity: 0.75; }

.bd-col-head {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  padding-top: 0.2rem;
}
.bd-col-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: var(--tracking-hd);
  color: var(--fg);
}
.bd-col-count { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-dim); }
.bd-col-spacer { flex: 1 1 auto; }
/* El número de atención de la etapa. */
.bd-col-stalled { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--warn); }
.bd-config { flex: 0 0 auto; }

.bd-list { list-style: none; margin: 0; padding: 0; }
.bd-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 0.55rem;
  padding: 0.45rem 0;
  align-items: baseline;
}
.bd-row + .bd-row { border-top: 1px solid var(--border-mute); }
.bd-row-glyph { display: flex; align-items: baseline; }
/* Mismo truco que la fila del listado: el glifo es la línea de estado con el
   texto oculto, para no mantener un segundo mapa de glifos. */
.bd-glyph-only :deep(.esl-text) { display: none; }
.bd-row-body { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.bd-row-title {
  margin: 0;
  font-size: var(--fs-body-sm);
  line-height: 1.4;
  color: var(--fg);
  text-wrap: pretty;
  overflow-wrap: anywhere;
}
.bd-row-issue {
  margin-left: 0.35rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
  text-decoration: none;
}
.bd-row-issue:hover { background: transparent; color: var(--info); }

.bd-note { margin: 0; font-size: var(--fs-micro); color: var(--fg-dimmer); }
/* "Qué corre acá" vivía en cada card de status; con el board vive al pie, que
   es donde la pregunta aparece: mirando una columna. */
.bd-rules-link { margin-left: 0.35rem; color: var(--ai); text-decoration: none; }
.bd-rules-link:hover { background: none; text-decoration: underline; }
.bd-error { display: flex; flex-direction: column; gap: 0.15rem; font-family: var(--font-mono); font-size: var(--fs-micro); }
.bd-error-line { margin: 0; color: var(--danger); overflow-wrap: anywhere; }
.bd-error-fix { margin: 0; color: var(--info); }
.bd-glyph { display: inline-block; width: 1.4ch; }


.repos-empty { font-size: var(--fs-body-sm); color: var(--fg-dim); padding: 0.5rem 0; }


.sc-agent-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border-mute);
  background: var(--panel-alt);
  color: var(--fg-mute);
  text-decoration: none;
}
.sc-agent-row:hover { background: var(--panel-hi); color: var(--fg); text-decoration: none; }
.sc-agent-row--first { border-color: var(--accent); }
.sc-agent-order { font-size: var(--fs-micro); color: var(--fg-dim); width: 1.4rem; flex-shrink: 0; }
.sc-agent-row--first .sc-agent-order { color: var(--accent); }
.sc-agent-name { font-family: var(--font-mono); font-size: var(--fs-body-sm); font-weight: 600; color: var(--fg); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-agent-off { font-size: var(--fs-micro); color: var(--fg-dim); flex-shrink: 0; }
.sc-agent-hint { font-size: var(--fs-micro); color: var(--accent); flex-shrink: 0; }
</style>
