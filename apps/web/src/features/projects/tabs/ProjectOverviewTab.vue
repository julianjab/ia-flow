<script setup lang="ts">
import type { Project } from '@ia-flow/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { useProjectsStore } from '@/features/projects/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import { fetchProjectHealth, type SourceHealthResponse } from '@/features/projects/sourceApi';
import { useToastStore } from '@/stores/toast';

const props = defineProps<{ project: Project | null }>();

const projectsStore = useProjectsStore();
const configStore = useProjectConfigStore();
const toastStore = useToastStore();

const nameDraft = ref('');
const urlDraft = ref('');
const saving = ref(false);

// Reset drafts when we navigate between projects or the list finishes loading.
watch(
  () => props.project?.id,
  () => {
    nameDraft.value = props.project?.name ?? '';
    urlDraft.value = props.project?.githubProjectUrl ?? '';
  },
  { immediate: true },
);

const dirty = computed(
  () =>
    (props.project && nameDraft.value.trim() !== props.project.name) ||
    (props.project && (urlDraft.value.trim() || null) !== (props.project.githubProjectUrl ?? null)),
);

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
// After the user saves a new URL, re-check.
watch(() => props.project?.githubProjectUrl, loadHealth);

async function save() {
  if (!props.project || !dirty.value) return;
  saving.value = true;
  try {
    await projectsStore.update(props.project.id, {
      name: nameDraft.value.trim(),
      githubProjectUrl: urlDraft.value.trim() || null,
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
  if (!window.confirm(`¿Archivar el proyecto '${props.project.name}'?`)) return;
  try {
    await projectsStore.archive(props.project.id);
    toastStore.success('Proyecto archivado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
</script>

<template>
  <section v-if="props.project" class="pot-section">
    <h2>Overview</h2>

    <!-- Health banner: red when a required field is missing, amber for warnings -->
    <div
      v-if="health && !healthLoading && (health.missing.length || health.warnings.length || health.message)"
      :class="['pot-health', health.missing.length || health.message ? 'pot-health--error' : 'pot-health--warn']"
      data-testid="project-health-banner"
    >
      <strong v-if="health.missing.length">
        ⚠︎ El GitHub Project no tiene el campo requerido:
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
      <label class="pot-field pot-field--full">
        <span class="pot-field__label">GitHub Project URL</span>
        <input v-model="urlDraft" class="pot-input" placeholder="https://github.com/orgs/xxx/projects/N" />
        <a
          v-if="props.project.githubProjectUrl"
          :href="props.project.githubProjectUrl"
          target="_blank"
          rel="noreferrer noopener"
          class="pot-field__link"
        >
          Abrir en GitHub ↗
        </a>
      </label>
    </div>

    <div class="pot-actions">
      <button class="pot-btn pot-btn--primary" :disabled="!dirty || saving" @click="save">
        {{ saving ? 'Guardando…' : 'Guardar' }}
      </button>
      <button class="pot-btn pot-btn--danger" @click="archive">Archivar proyecto</button>
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
.pot-field__link {
  font-size: 0.75rem;
  color: #2563eb;
  text-decoration: none;
  align-self: flex-start;
}
.pot-field__link:hover { text-decoration: underline; }
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
.pot-btn:disabled { opacity: 0.5; cursor: not-allowed; }
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
