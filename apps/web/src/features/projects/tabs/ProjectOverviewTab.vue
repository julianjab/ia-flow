<script setup lang="ts">
import type { Project } from '@ia-flow/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectsStore } from '@/features/projects/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import {
  fetchCascadePreview,
  fetchPollingStatus,
  pausePolling,
  resumePolling,
  type CascadePreview,
} from '@/features/projects/api';
import { fetchProjectHealth, type SourceHealthResponse } from '@/features/projects/sourceApi';
import { useServerEvents } from '@/composables/useServerEvents';
import { useToastStore } from '@/stores/toast';

const props = defineProps<{ project: Project | null }>();

const projectsStore = useProjectsStore();
const configStore = useProjectConfigStore();
const toastStore = useToastStore();
const router = useRouter();

const nameDraft = ref('');
const saving = ref(false);

// Reset drafts when we navigate between projects or the list finishes loading.
watch(
  () => props.project?.id,
  () => {
    nameDraft.value = props.project?.name ?? '';
  },
  { immediate: true },
);

const dirty = computed(
  () => props.project && nameDraft.value.trim() !== props.project.name,
);

const sourceKind = computed(() => props.project?.source?.kind ?? 'local');
const githubUrl = computed(() => {
  const s = props.project?.source;
  if (!s || s.kind !== 'github') return null;
  const url = s.config?.url;
  return typeof url === 'string' && url ? url : null;
});

// ─── Source health ────────────────────────────────────────────────────────
// Refetched whenever the active project changes so switching projects
// doesn't linger on the previous one's banner.
const health = ref<SourceHealthResponse | null>(null);
const healthLoading = ref(false);

async function loadHealth() {
  if (!props.project) { health.value = null; return; }
  healthLoading.value = true;
  try {
    health.value = await fetchProjectHealth(props.project.id);
  } catch (e) {
    health.value = {
      kind: 'unknown',
      ok: false,
      missing: [],
      warnings: [],
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    healthLoading.value = false;
  }
}

onMounted(loadHealth);
watch(() => props.project?.id, loadHealth);
// After the source changes in the Provider tab, re-check.
watch(() => props.project?.source, loadHealth, { deep: true });

// ─── Polling pause (in-memory, per-project) ─────────────────────────────
const pollingPaused = ref(false);
const pollingLoading = ref(false);
const pollingToggling = ref(false);

async function loadPollingStatus() {
  if (!props.project) { pollingPaused.value = false; return; }
  pollingLoading.value = true;
  try {
    const s = await fetchPollingStatus(props.project.id);
    pollingPaused.value = s.paused;
  } finally {
    pollingLoading.value = false;
  }
}

onMounted(loadPollingStatus);
watch(() => props.project?.id, loadPollingStatus);

// Server broadcasts on any pause/resume so a second tab stays in sync.
useServerEvents((msg) => {
  if (msg.type !== 'project:polling') return;
  if (msg.projectId === props.project?.id) {
    pollingPaused.value = Boolean(msg.paused);
  }
});

async function togglePolling() {
  if (!props.project || pollingToggling.value) return;
  pollingToggling.value = true;
  const id = props.project.id;
  const target = !pollingPaused.value;
  try {
    const s = target ? await pausePolling(id) : await resumePolling(id);
    pollingPaused.value = s.paused;
    toastStore.success(s.paused ? 'Polling pausado' : 'Polling reanudado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    pollingToggling.value = false;
  }
}

async function save() {
  if (!props.project || !dirty.value) return;
  saving.value = true;
  try {
    await projectsStore.update(props.project.id, {
      name: nameDraft.value.trim(),
    });
    toastStore.success('Proyecto actualizado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

async function archive() {
  if (!props.project) return;
  const { id, name } = props.project;
  if (!window.confirm(`¿Archivar el proyecto '${name}'?`)) return;
  try {
    await projectsStore.archive(id);
    // Route away before toast: once the list refetches without this project,
    // ProjectDetailView renders "Proyecto no encontrado" until we navigate.
    router.push('/projects');
    toastStore.success('Proyecto archivado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Cascade delete ───────────────────────────────────────────────────────
// Two-step confirmation: open dialog → fetch preview → require typing the
// project name to enable the destructive button. Meant to be scary; this
// action can't be undone.
const deleteOpen = ref(false);
const deletePreview = ref<CascadePreview | null>(null);
const deletePreviewLoading = ref(false);
const deleteConfirmText = ref('');
const deleting = ref(false);

async function openDeleteDialog() {
  if (!props.project) return;
  deleteConfirmText.value = '';
  deletePreview.value = null;
  deleteOpen.value = true;
  deletePreviewLoading.value = true;
  try {
    deletePreview.value = await fetchCascadePreview(props.project.id);
  } catch (e) {
    toastStore.error(`No se pudo cargar el preview: ${e instanceof Error ? e.message : String(e)}`);
    deleteOpen.value = false;
  } finally {
    deletePreviewLoading.value = false;
  }
}

const deleteConfirmed = computed(
  () => !!props.project && deleteConfirmText.value.trim() === props.project.name,
);

async function confirmDelete() {
  if (!props.project || !deleteConfirmed.value) return;
  // Snapshot id + name BEFORE the await — deleteCascade re-fetches the
  // projects list, so by the time it resolves `props.project` from the
  // parent computed has flipped to null and any read here would throw.
  const { id, name } = props.project;
  deleting.value = true;
  try {
    await projectsStore.deleteCascade(id);
    deleteOpen.value = false;
    router.push('/projects');
    toastStore.success(`Proyecto '${name}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <section v-if="props.project" class="pot-section">
    <h2>Overview</h2>

    <!-- Health banner: red when a required field is missing, amber for warnings.
         Uses `health.kind` (from the source impl) instead of hard-coding
         "GitHub Project" so the message stays truthful for other kinds. -->
    <div
      v-if="health && !healthLoading && (health.missing.length || health.warnings.length || health.message)"
      :class="['pot-health', health.missing.length || health.message ? 'pot-health--error' : 'pot-health--warn']"
      data-testid="project-health-banner"
    >
      <strong v-if="health.missing.length">
        ⚠︎ La fuente <code>{{ health.kind }}</code> no tiene el campo requerido:
        {{ health.missing.map((f) => f.name).join(', ') }}
      </strong>
      <strong v-else-if="health.message">
        ⚠︎ {{ health.message }}
      </strong>
      <strong v-else>
        Sugerencia: agrega los campos {{ health.warnings.map((f) => f.name).join(', ') }} para mejor contexto.
      </strong>
      <ul class="pot-health__list">
        <li v-for="f in health.missing" :key="`m-${f.name}`">
          <code>{{ f.name }}</code> — {{ f.purpose }}
        </li>
        <li v-for="f in health.warnings" :key="`w-${f.name}`" class="pot-health__warn-item">
          <code>{{ f.name }}</code> — {{ f.purpose }}
        </li>
      </ul>
    </div>

    <div class="pot-grid">
      <label class="pot-field">
        <span class="pot-field__label">Nombre</span>
        <input v-model="nameDraft" class="pot-input" />
      </label>
      <label class="pot-field">
        <span class="pot-field__label">ID</span>
        <input :value="props.project.id" class="pot-input pot-input--mono" disabled />
      </label>
      <div class="pot-field pot-field--full">
        <span class="pot-field__label">Fuente</span>
        <div class="pot-source">
          <span :class="['pot-badge', `pot-badge--${sourceKind}`]">{{ sourceKind }}</span>
          <a
            v-if="githubUrl"
            :href="githubUrl"
            target="_blank"
            rel="noreferrer noopener"
            class="pot-source__link"
          >
            Abrir en GitHub ↗
          </a>
          <span class="pot-source__hint">
            La configuración de la fuente se edita en la pestaña <em>Provider</em>.
          </span>
        </div>
      </div>
    </div>

    <div class="pot-actions">
      <button class="pot-btn pot-btn--primary" :disabled="!dirty || saving" @click="save">
        {{ saving ? 'Guardando…' : 'Guardar' }}
      </button>
      <button
        class="pot-btn"
        :class="pollingPaused ? 'pot-btn--primary' : 'pot-btn--danger'"
        :disabled="pollingLoading || pollingToggling"
        :title="pollingPaused ? 'Reanudar polling del proyecto' : 'Pausar polling del proyecto (en memoria, no persiste al reiniciar)'"
        data-testid="project-polling-toggle"
        @click="togglePolling"
      >
        <span v-if="pollingLoading">…</span>
        <span v-else-if="pollingToggling">{{ pollingPaused ? 'Reanudando…' : 'Pausando…' }}</span>
        <span v-else>{{ pollingPaused ? '▶ Reanudar polling' : '⏸ Pausar polling' }}</span>
      </button>
      <button class="pot-btn pot-btn--danger" @click="archive">Archivar proyecto</button>
      <button class="pot-btn pot-btn--destructive" @click="openDeleteDialog">
        Eliminar permanentemente…
      </button>
    </div>

    <hr />

    <div class="pot-summary">
      <div class="pot-summary__item">
        <span class="pot-summary__label">Agentes del proyecto</span>
        <span class="pot-summary__value">{{ configStore.config?.agents?.length ?? 0 }}</span>
      </div>
      <div class="pot-summary__item">
        <span class="pot-summary__label">Statuses</span>
        <span class="pot-summary__value">{{ configStore.config?.statuses?.length ?? 0 }}</span>
      </div>
      <div class="pot-summary__item">
        <span class="pot-summary__label">System Prompts</span>
        <span class="pot-summary__value">{{ configStore.config?.systemPrompts?.length ?? 0 }}</span>
      </div>
    </div>

    <!-- Cascade-delete confirmation. Type-to-confirm so the user can't
         click through by accident; the action is irreversible. -->
    <div v-if="deleteOpen" class="pot-modal-backdrop" @click.self="deleteOpen = false">
      <div class="pot-modal" role="dialog" aria-modal="true" aria-labelledby="pot-del-title">
        <header class="pot-modal__header">
          <h3 id="pot-del-title">Eliminar proyecto permanentemente</h3>
          <button class="pot-modal__close" @click="deleteOpen = false" aria-label="Cerrar">×</button>
        </header>
        <div class="pot-modal__body">
          <p class="pot-modal__lead">
            Vas a eliminar <strong>{{ props.project?.name }}</strong> y todo lo que le pertenece.
            <strong>Esta acción no se puede deshacer.</strong>
          </p>

          <div v-if="deletePreviewLoading" class="pot-modal__loading">Calculando impacto…</div>
          <ul v-else-if="deletePreview" class="pot-modal__list">
            <li><code>{{ deletePreview.agents }}</code> agentes del proyecto</li>
            <li><code>{{ deletePreview.systemPrompts }}</code> system prompts del proyecto</li>
            <li><code>{{ deletePreview.statuses }}</code> statuses</li>
            <li class="pot-modal__list-note">
              Los agentes y system prompts <em>globales</em> (compartidos con otros proyectos) no se tocan.
            </li>
          </ul>

          <label class="pot-modal__confirm">
            <span>
              Para confirmar, escribe el nombre del proyecto:
              <code>{{ props.project?.name }}</code>
            </span>
            <input
              v-model="deleteConfirmText"
              class="pot-input"
              :placeholder="props.project?.name"
              autofocus
            />
          </label>
        </div>
        <footer class="pot-modal__footer">
          <button class="pot-btn" @click="deleteOpen = false" :disabled="deleting">
            Cancelar
          </button>
          <button
            class="pot-btn pot-btn--destructive"
            :disabled="!deleteConfirmed || deleting"
            @click="confirmDelete"
          >
            {{ deleting ? 'Eliminando…' : 'Eliminar permanentemente' }}
          </button>
        </footer>
      </div>
    </div>
  </section>
  <div v-else class="pot-empty">Proyecto no encontrado.</div>
</template>

<style scoped>
.pot-section {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 1.25rem;
}
.pot-section h2 { margin: 0 0 1rem; font-size: 1.15rem; }
.pot-health {
  padding: 0.75rem 1rem;
  border-radius: 8px;
  margin-bottom: 1rem;
  font-size: 0.85rem;
}
.pot-health--error {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
}
.pot-health--warn {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
}
.pot-health strong { display: block; margin-bottom: 0.35rem; }
.pot-health__list { margin: 0.25rem 0 0 1.25rem; padding: 0; }
.pot-health__list li { line-height: 1.4; }
.pot-health__list code {
  background: rgba(0,0,0,0.06);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.pot-health__warn-item { opacity: 0.85; }
.pot-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.85rem;
}
.pot-field { display: flex; flex-direction: column; gap: 0.35rem; }
.pot-field--full { grid-column: 1 / -1; }
.pot-field__label { font-size: 0.85rem; color: #374151; font-weight: 500; }
.pot-source {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.pot-source__link {
  font-size: 0.8rem;
  color: #2563eb;
  text-decoration: none;
}
.pot-source__link:hover { text-decoration: underline; }
.pot-source__hint { font-size: 0.75rem; color: #6b7280; }
.pot-badge {
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 500;
  background: #f3f4f6;
  color: #374151;
}
.pot-badge--github { background: #dbeafe; color: #1d4ed8; }
.pot-input {
  padding: 0.5rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.9rem;
}
.pot-input--mono { font-family: ui-monospace, SFMono-Regular, monospace; }
.pot-input:disabled { background: #f9fafb; color: #6b7280; }
.pot-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
.pot-btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
  border: 1px solid transparent;
}
.pot-btn--primary { background: #111827; color: #fff; }
.pot-btn--danger { background: #fff; color: #b91c1c; border-color: #fecaca; }
.pot-btn--destructive { background: #b91c1c; color: #fff; border-color: #b91c1c; }
.pot-btn--destructive:not(:disabled):hover { background: #991b1b; }
.pot-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ─── Cascade-delete modal ──────────────────────────────────────────────── */
.pot-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(17, 24, 39, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.pot-modal {
  background: #fff;
  border-radius: 12px;
  width: min(520px, 92vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 40px rgba(0,0,0,0.2);
}
.pot-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #e5e7eb;
}
.pot-modal__header h3 { margin: 0; font-size: 1.05rem; color: #991b1b; }
.pot-modal__close {
  background: none; border: none;
  font-size: 1.4rem; color: #6b7280;
  cursor: pointer; line-height: 1;
}
.pot-modal__body {
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
}
.pot-modal__lead { margin: 0; font-size: 0.9rem; line-height: 1.5; }
.pot-modal__loading { color: #6b7280; font-size: 0.85rem; }
.pot-modal__list {
  margin: 0;
  padding: 0.75rem 1rem 0.75rem 1.75rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  color: #7f1d1d;
  font-size: 0.85rem;
  line-height: 1.6;
}
.pot-modal__list code {
  background: rgba(0,0,0,0.06);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.pot-modal__list-note {
  list-style: none;
  margin-left: -1rem;
  margin-top: 0.5rem;
  color: #6b7280;
  font-size: 0.8rem;
}
.pot-modal__confirm {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.85rem;
}
.pot-modal__confirm code {
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: #f3f4f6;
  padding: 0.05rem 0.35rem;
  border-radius: 3px;
}
.pot-modal__footer {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  padding: 0.85rem 1.25rem;
  border-top: 1px solid #e5e7eb;
}
hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5rem 0; }
.pot-summary { display: flex; gap: 2rem; flex-wrap: wrap; }
.pot-summary__item { display: flex; flex-direction: column; gap: 0.15rem; }
.pot-summary__label { font-size: 0.8rem; color: #6b7280; }
.pot-summary__value { font-size: 1.25rem; font-weight: 600; }
.pot-empty {
  padding: 2rem;
  color: #6b7280;
  text-align: center;
}
</style>
