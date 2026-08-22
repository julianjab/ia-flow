<script setup lang="ts">
import type { PullRequestRef } from '@ia-flow/shared';
import { ref, watch, computed } from 'vue';
import TaskTags from '@/components/TaskTags.vue';

const props = defineProps<{
  open: boolean;
  issueNumber: number;
  issueTitle: string;
  currentRepos: string[];
  availableRepos: string[];
  saving?: boolean;
  // Dev links de la tarea. Opcionales: un provider sin noción de ramas/PRs
  // (local-fs) simplemente no los pasa y el bloque no se dibuja.
  issueUrl?: string;
  branch?: string;
  branchUrl?: string;
  pullRequests?: PullRequestRef[];
  devLinks?: boolean;
  pullRequestsKnown?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  save: [repos: string[]];
}>();

const selected = ref<string[]>([]);

watch(() => props.open, (open) => {
  if (open) selected.value = [...props.currentRepos];
});

function toggle(repo: string) {
  const idx = selected.value.indexOf(repo);
  if (idx === -1) selected.value.push(repo);
  else selected.value.splice(idx, 1);
}

const hasChanges = computed(
  () => JSON.stringify([...selected.value].sort()) !== JSON.stringify([...props.currentRepos].sort())
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="backdrop" @click.self="emit('close')">
      <div class="modal">
        <header class="modal-head">
          <div class="modal-head-text">
            <span class="modal-title">Editar repos</span>
            <span class="modal-subtitle">
              <a
                v-if="issueUrl"
                class="modal-issue-link"
                :href="issueUrl"
                target="_blank"
                rel="noopener"
                :title="`Abrir #${issueNumber} en el provider`"
              >#{{ issueNumber }}<span class="modal-issue-glyph">↗</span></a>
              <span v-else class="modal-issue-link is-plain">#{{ issueNumber }}</span>
              <span class="modal-issue-title" :title="issueTitle">{{ issueTitle }}</span>
            </span>
          </div>
          <button class="close-btn" @click="emit('close')">✕</button>
        </header>

        <div class="modal-body">
          <section v-if="devLinks" class="dev-block">
            <span class="uc-label">Development</span>
            <TaskTags
              :branch="branch"
              :branch-url="branchUrl"
              :pull-requests="pullRequests"
              :dev-links="devLinks"
              :pull-requests-known="pullRequestsKnown"
            />
          </section>

          <p class="hint">Selecciona los repos que afecta esta tarea.</p>

          <div v-if="availableRepos.length" class="repo-grid">
            <button
              v-for="repo in availableRepos"
              :key="repo"
              type="button"
              class="repo-chip"
              :class="{ active: selected.includes(repo) }"
              @click="toggle(repo)"
            >
              <span class="chip-check">{{ selected.includes(repo) ? '✓' : '' }}</span>
              <span class="chip-name">{{ repo }}</span>
            </button>
          </div>

          <p v-else class="empty">No hay repos configurados. Agrega repos en la tab Repos.</p>

          <div v-if="selected.length" class="selected-preview">
            <span class="preview-label">Seleccionados:</span>
            <span v-for="r in selected" :key="r" class="preview-chip">{{ r }}</span>
          </div>
        </div>

        <footer class="modal-foot">
          <button class="btn" @click="emit('close')">Cancelar</button>
          <button
            class="btn btn--primary"
            :disabled="saving || !hasChanges"
            @click="emit('save', [...selected])"
          >
            {{ saving ? 'Guardando…' : 'Guardar' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 1rem;
}
.modal {
  background: var(--panel);
  border-radius: var(--radius);
  width: min(520px, 100%);
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 1rem 1.25rem 0.75rem;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.modal-head-text { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.modal-title { font-size: var(--fs-body); font-weight: 700; text-transform: uppercase; letter-spacing: var(--tracking-hd); color: var(--fg); }
/* El `#numero ↗` es ancho fijo y siempre clickeable; el título envuelve —
   mismo criterio que la card del listado: un subtítulo truncado esconde
   justo la parte del título que distingue una tarea de otra. */
.modal-subtitle { display: flex; align-items: baseline; gap: 0.35rem; min-width: 0; font-size: var(--fs-chrome); color: var(--fg-dim); }
.modal-issue-title { min-width: 0; overflow-wrap: anywhere; }
.close-btn {
  flex-shrink: 0;
  background: none;
  border: none;
  font-size: var(--fs-body);
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0.2rem 0.35rem;
  line-height: 1;
}
.close-btn:hover { color: var(--fg); }

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.hint { margin: 0; font-size: var(--fs-chrome); color: var(--fg-dim); }
.modal-issue-link {
  flex: 0 0 auto;
  color: var(--fg-dim);
  text-decoration: none;
  font-family: var(--font-mono);
  white-space: nowrap;
}
.modal-issue-link:hover:not(.is-plain) { color: var(--info); }
.modal-issue-glyph { margin-left: 0.15rem; color: var(--fg-dimmer); }
.modal-issue-link:hover:not(.is-plain) .modal-issue-glyph { color: var(--info); }

.dev-block { display: flex; flex-direction: column; gap: 0.4rem; }

.repo-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.repo-chip {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  height: calc(var(--row-h) + 0.35rem);
  padding: 0 0.7rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius-sm);
  font-size: var(--fs-body-sm);
  color: var(--fg-mute);
  background: var(--panel);
  cursor: pointer;
  user-select: none;
  transition: border-color 0.1s, background 0.1s, color 0.1s;
  font-family: var(--font-mono);
}
.repo-chip:hover { border-color: var(--info); color: var(--info); }
.repo-chip.active { border-color: var(--info); background: var(--panel-hi); color: var(--info); font-weight: 500; }
.chip-check { width: 1ch; font-size: var(--fs-micro); color: var(--accent); }

.empty { margin: 0; font-size: var(--fs-chrome); color: var(--fg-dimmer); }

.selected-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  padding: 0.6rem 0.75rem;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.preview-label { font-size: var(--fs-micro); color: var(--fg-dim); flex-shrink: 0; }
.preview-chip {
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  padding: 0 0.4rem;
  background: var(--panel-hi);
  color: var(--info);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem 1rem;
  border-top: 1px solid var(--panel-hi);
  flex-shrink: 0;
}

</style>
