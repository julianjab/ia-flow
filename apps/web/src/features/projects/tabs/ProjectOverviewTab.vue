<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import type { Project } from '@ia-flow/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { projectSourceUrl, sourceKindLabel } from '@/features/projects/meta';
import { useProjectsStore } from '@/features/projects/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import {
  fetchCascadePreview,
  type CascadePreview,
} from '@/features/projects/api';
import { fetchProjectHealth, type SourceHealthResponse } from '@/features/projects/sourceApi';
import { useToastStore } from '@/stores/toast';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';

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
const githubUrl = computed(() => projectSourceUrl(props.project?.source));

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
      message: extractErrorMessage(e),
    };
  } finally {
    healthLoading.value = false;
  }
}

onMounted(loadHealth);
watch(() => props.project?.id, loadHealth);
// After the source changes in the Provider tab, re-check.
watch(() => props.project?.source, loadHealth, { deep: true });

async function save() {
  if (!props.project || !dirty.value) return;
  saving.value = true;
  try {
    await projectsStore.update(props.project.id, {
      name: nameDraft.value.trim(),
    });
    toastStore.success('Proyecto actualizado');
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  } finally {
    saving.value = false;
  }
}

function archive() {
  if (!props.project) return;
  const { id, name } = props.project;
  pendingConfirm.value = {
    title: 'Archivar proyecto',
    message: `¿Archivar el proyecto '${name}'?`,
    confirmLabel: 'Archivar',
    // El id viaja al callback en vez de releerse de props: entre que se abre
    // el diálogo y se confirma, el proyecto activo pudo cambiar.
    onConfirm: () => doArchive(id),
  };
}

async function doArchive(id: string) {
  try {
    await projectsStore.archive(id);
    // Route away before toast: once the list refetches without this project,
    // ProjectDetailView renders "Proyecto no encontrado" until we navigate.
    router.push('/projects');
    toastStore.success('Proyecto archivado');
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
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
    toastStore.error(`No se pudo cargar el preview: ${extractErrorMessage(e)}`);
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
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  } finally {
    deleting.value = false;
  }
}

/** Confirmación in-app en vez de `confirm()` nativo: los botones del nativo los
 *  pinta el sistema operativo en el idioma del DISPOSITIVO, así que en un
 *  teléfono en inglés el mensaje sale en español con "OK / Cancel" abajo. */
const pendingConfirm = ref<{
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
} | null>(null);

async function runConfirm() {
  const c = pendingConfirm.value;
  if (!c) return;
  pendingConfirm.value = null;
  await c.onConfirm();
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
          <span :class="['pot-badge', `pot-badge--${sourceKind}`]">{{ sourceKindLabel(sourceKind) }}</span>
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
      <!-- Los tres niveles del sistema, en orden de peso: guardar (primario),
           archivar (peligroso pero reversible, contorno) y borrar (destructivo,
           relleno). Ver DESIGN_SYSTEM.md → Botones. -->
      <button class="btn btn--primary" :disabled="!dirty || saving" @click="save">
        {{ saving ? 'Guardando…' : 'Guardar' }}
      </button>
      <button class="btn btn--danger" @click="archive">Archivar proyecto</button>
      <button class="btn btn--destructive" @click="openDeleteDialog">
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
          <button class="btn" @click="deleteOpen = false" :disabled="deleting">
            Cancelar
          </button>
          <button
            class="btn btn--destructive"
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

    <ConfirmDialog
      :open="!!pendingConfirm"
      :title="pendingConfirm?.title"
      :message="pendingConfirm?.message ?? ''"
      :confirm-label="pendingConfirm?.confirmLabel"
      danger
      @confirm="runConfirm"
      @cancel="pendingConfirm = null"
    />

</template>

<style scoped>
.pot-section {
  background: var(--panel);
  border: 1px solid var(--border);
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
  background: var(--red-bg);
  border: 1px solid var(--danger);
  color: var(--danger);
}
.pot-health--warn {
  background: var(--yellow-bg);
  border: 1px solid var(--warn);
  color: var(--warn);
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
  /* `minmax(0, 1fr)` y no `1fr`: el minimo implicito de una pista de grid es
     `auto`, o sea el ancho de su contenido. Con `1fr` pelado, un input o una
     URL larga estiran la columna y el grid entero se sale de la pantalla —
     que es lo que pasaba acá. */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0.85rem;
}
@media (max-width: 640px) {
  /* Una columna: dos campos de formulario lado a lado en 390px dejan ~180px
     para cada input, que no alcanza para leer una URL ni un path. */
  .pot-grid { grid-template-columns: 1fr; }
  /* `--full` ya no significa nada con una sola columna, pero la regla sigue
     siendo valida y explicita. */
  .pot-field--full { grid-column: 1; }
  /* Los botones de accion se apilan en vez de salirse. */
  .pot-actions { flex-wrap: wrap; }
  .pot-actions > * { flex: 1 1 auto; }
}
/* `min-width: 0` para que el campo pueda encoger dentro de su pista: sin eso
   su minimo es el de su contenido y `minmax(0, …)` no alcanza. */
.pot-field { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
.pot-field--full { grid-column: 1 / -1; }
.pot-field__label { font-size: 0.85rem; color: var(--fg-mute); font-weight: 500; }
/* URLs y paths son tokens sin espacios: sin esto su ancho minimo empuja igual. */
.pot-field, .pot-field * { overflow-wrap: anywhere; }
.pot-input { max-width: 100%; box-sizing: border-box; }
.pot-source {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.pot-source__link {
  font-size: 0.8rem;
  color: var(--accent);
  text-decoration: none;
}
.pot-source__link:hover { text-decoration: underline; }
.pot-source__hint { font-size: 0.75rem; color: var(--fg-dim); }
.pot-badge {
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 500;
  background: var(--panel-hi);
  color: var(--fg-mute);
}
.pot-badge--github-projects,
.pot-badge--github,
.pot-badge--github-issues { background: var(--panel-hi); color: var(--accent); }
.pot-input {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.9rem;
}
.pot-input--mono { font-family: ui-monospace, SFMono-Regular, monospace; }
.pot-input:disabled { background: var(--panel-alt); color: var(--fg-dim); }
.pot-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }

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
  background: var(--panel);
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
  border-bottom: 1px solid var(--border);
}
.pot-modal__header h3 { margin: 0; font-size: 1.05rem; color: var(--danger); }
.pot-modal__close {
  background: none; border: none;
  font-size: 1.4rem; color: var(--fg-dim);
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
.pot-modal__loading { color: var(--fg-dim); font-size: 0.85rem; }
.pot-modal__list {
  margin: 0;
  padding: 0.75rem 1rem 0.75rem 1.75rem;
  background: var(--red-bg);
  border: 1px solid var(--danger);
  border-radius: 6px;
  color: var(--danger);
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
  color: var(--fg-dim);
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
  background: var(--panel-hi);
  padding: 0.05rem 0.35rem;
  border-radius: 3px;
}
.pot-modal__footer {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  padding: 0.85rem 1.25rem;
  border-top: 1px solid var(--border);
}
hr { border: none; border-top: 1px solid var(--border); margin: 1.5rem 0; }
.pot-summary { display: flex; gap: 2rem; flex-wrap: wrap; }
.pot-summary__item { display: flex; flex-direction: column; gap: 0.15rem; }
.pot-summary__label { font-size: 0.8rem; color: var(--fg-dim); }
.pot-summary__value { font-size: 1.25rem; font-weight: 600; }
.pot-empty {
  padding: 2rem;
  color: var(--fg-dim);
  text-align: center;
}
</style>
