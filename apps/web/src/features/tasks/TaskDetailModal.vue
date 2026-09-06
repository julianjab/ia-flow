<script setup lang="ts">
import type { PullRequestRef, RunTaskNowResult } from '@ia-flow/shared';
import { computed } from 'vue';
import TaskTags from '@/components/TaskTags.vue';

const props = defineProps<{
  open: boolean;
  issueNumber: number;
  issueTitle: string;
  /** Repos que toca la tarea. Sólo lectura: quién los decide es la fuente
   *  (el campo del board, el repo dueño del issue, los head repos de sus PRs),
   *  y no todas saben persistirlos — `github-issues` los deriva de su config.
   *  Un editor que sólo funciona en algunas fuentes es peor que un dato. */
  repos: string[];
  // Dev links de la tarea. Opcionales: un provider sin noción de ramas/PRs
  // (local-fs) simplemente no los pasa y el bloque no se dibuja.
  issueUrl?: string;
  branch?: string;
  branchUrl?: string;
  pullRequests?: PullRequestRef[];
  devLinks?: boolean;
  pullRequestsKnown?: boolean;
  /** Status actual de la tarea — es contra ESTO que se evalúan las reglas
   *  cuando se la corre, así que se muestra al lado del botón. */
  status?: string;
  /** Hay un pedido en vuelo. */
  running?: boolean;
  /** Resultado del último pedido en esta apertura del modal. Se muestra acá y
   *  no sólo como toast: el toast se va, y el caso interesante —"ninguna regla
   *  matchea"— es justamente el que uno necesita releer mientras decide qué
   *  cambiar. */
  runResult?: RunTaskNowResult | null;
}>();

const emit = defineEmits<{
  close: [];
  run: [];
}>();

/** Qué decir del último intento, en el idioma del operador. */
const runMessage = computed(() => {
  const r = props.runResult;
  if (!r) return null;
  if (r.outcome === 'dispatched')
    return { ok: true, text: `Corriendo — una regla tomó el status "${r.status}".` };
  if (r.outcome === 'deferred')
    return { ok: true, text: 'En cola: la capacidad está ocupada; arranca al liberarse un slot.' };
  return {
    ok: false,
    text: `Ninguna regla matchea el status "${r.status}", así que no se despachó ningún agente. Revisá las reglas del proyecto.`,
  };
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="backdrop" @click.self="emit('close')">
      <div class="modal">
        <header class="modal-head">
          <div class="modal-head-text">
            <span class="modal-title">Detalle de la tarea</span>
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

          <section class="repos-block">
            <span class="uc-label">Repos</span>
            <div v-if="repos.length" class="repo-list">
              <span v-for="r in repos" :key="r" class="repo-chip is-static">{{ r }}</span>
            </div>
            <p v-else class="empty">La fuente no reporta ningún repo para esta tarea.</p>
          </section>

          <section class="run-block">
            <span class="uc-label">Ejecución</span>
            <div class="run-row">
              <button
                type="button"
                class="btn btn--primary run-btn"
                :disabled="running"
                @click="emit('run')"
              >
                {{ running ? 'Pidiendo…' : '▷ Correr ahora' }}
              </button>
              <p class="run-explain">
                Vuelve a evaluar las reglas contra el status
                <code v-if="status" class="run-status">{{ status }}</code>
                <span v-else class="run-status is-empty">sin status</span>
                sin mover la tarea en el board.
              </p>
            </div>
            <p v-if="runMessage" class="run-result" :class="{ 'is-error': !runMessage.ok }">
              {{ runMessage.text }}
            </p>
          </section>
        </div>

        <footer class="modal-foot">
          <button class="btn" @click="emit('close')">Cerrar</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.repos-block,
.run-block {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--border);
}
.repo-list { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.repo-chip.is-static {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  padding: 0.15rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  color: var(--fg);
}
.run-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.run-btn { flex: 0 0 auto; }
.run-explain { margin: 0; font-size: var(--fs-micro); color: var(--fg-dim); flex: 1 1 12rem; }
.run-status {
  font-family: var(--font-mono);
  color: var(--fg);
}
.run-status.is-empty { color: var(--fg-dim); font-style: italic; }
.run-result {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--fg);
}
/* El "ninguna regla matchea" no es un fallo del server: es config para
   revisar. Se marca distinto porque el operador tiene que poder distinguirlo
   de un run que sí arrancó. */
.run-result.is-error { color: var(--danger, #c0392b); }

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

.empty { margin: 0; font-size: var(--fs-chrome); color: var(--fg-dimmer); }

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem 1rem;
  border-top: 1px solid var(--panel-hi);
  flex-shrink: 0;
}
</style>
