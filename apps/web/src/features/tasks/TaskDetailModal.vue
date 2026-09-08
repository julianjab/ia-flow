<script setup lang="ts">
import type { ExecutionLog, PullRequestRef, RunTaskNowResult } from '@ia-flow/shared';
import { computed } from 'vue';
import TaskTags from '@/components/TaskTags.vue';
import ExecutionStatusLine from '@/components/ExecutionStatusLine.vue';
import TaskExecutions from '@/features/tasks/TaskExecutions.vue';
import RunPreviewCard from '@/features/tasks/RunPreviewCard.vue';

const props = defineProps<{
  open: boolean;
  /** Identidad de la tarea — la sección de ejecuciones consulta por ella. */
  taskId: string | null;
  projectId: string | null;
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
  /** El status que se está aplicando ahora, para el botón de la sugerencia. */
  movingStatus?: string | null;
  /** Cambia cuando la tarea se movió: la preview tiene que volver a preguntar,
   *  o sigue ofreciendo el mismo `mover a` que ya se aplicó. */
  moveToken?: number;
  /** Slack configurado en este server. Sin credencial la acción ni se ofrece:
   *  fallaría con un 503 y sin dónde ver por qué. */
  slackEnabled?: boolean;
  /** Por qué NO se puede pedir review (sin PR abierto, CI corriendo, sin
   *  reviewers). El botón lo muestra como tooltip en vez de esconderse. */
  slackBlockedReason?: string | null;
  slackBusy?: boolean;
  /** Ya hay un hilo: el pedido siguiente es un re-review. */
  slackThreadUrl?: string | null;
  /** El último run de la tarea, si corrió. Es lo que decide cuál es la acción
   *  principal de la pantalla. */
  execution?: ExecutionLog | null;
  attempts?: number;
  blocked?: boolean;
  /** Ya llegó el agregado de runs. Sin esto no se afirma "sin ejecutar". */
  runsKnown?: boolean;
  /** Hay un cancel en vuelo. */
  cancelling?: boolean;
  /**
   * Segunda COLUMNA en vez de overlay (`--bp-split`).
   *
   * Sobre 1100px hay ancho para que el detalle viva al lado de la lista en vez
   * de flotar encima: la lista queda entera y usable, que es lo que permite
   * recorrer varias tareas seguidas con el teclado sin cerrar y abrir. Es el
   * breakpoint que el design system define como "aparece la segunda columna".
   *
   * Abajo sigue siendo overlay (panel lateral) y, bajo `--bp-shell`, la
   * pantalla completa. Un solo componente, tres formas.
   */
  inline?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  run: [];
  'slack-review': [];
  'cancel-run': [];
  logs: [];
  /** Mover la tarea a un status, desde la sugerencia de `RunPreviewCard`. Lo
   *  ejecuta el padre: es quien tiene el api de la fuente y quien tiene que
   *  refrescar la lista después. */
  move: [status: string];
}>();

/** En qué estado está la tarea. Es lo que decide la barra de acciones: no hay
 *  una acción principal fija, hay una por estado. */
const state = computed<'running' | 'failed' | 'stopped' | 'done' | 'idle'>(() => {
  const e = props.execution;
  if (e && !e.finishedAt) return 'running';
  if (e?.outcome === 'error') return 'failed';
  // `cancelled` y `truncated` NO son éxito: el primero lo escribe el botón de
  // abortar de esta misma pantalla, y el segundo es un run cortado por budget.
  // Tratarlos como "terminó" dejaba la tarjeta en verde y "Ver PR" de acción
  // principal sobre trabajo que quedó a medias.
  if (e?.outcome === 'cancelled' || e?.outcome === 'truncated') return 'stopped';
  if (e) return 'done';
  return 'idle';
});

/** El PR abierto, que es lo que la acción principal de una tarea terminada
 *  ofrece mirar. */
const openPr = computed(() => props.pullRequests?.find((pr) => pr.state === 'open') ?? null);

/** La meta del run: quién, con qué y desde cuándo. */
const runMeta = computed(() => {
  const e = props.execution;
  if (!e) return null;
  const started = new Date(e.startedAt);
  const at = Number.isNaN(started.getTime())
    ? null
    : started.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return [e.agentId, e.providerId, at ? `arrancó ${at}` : null].filter(Boolean).join(' · ');
});

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
  <!-- `:disabled` en vez de un `v-if` que duplique el árbol: teleportar o no es
       lo ÚNICO que cambia entre el overlay y la columna. Con dos ramas, el
       contenido del detalle se escribiría dos veces y divergirían. -->
  <Teleport to="body" :disabled="inline">
    <div v-if="open" class="backdrop" :class="{ 'backdrop--inline': inline }" @click.self="inline ? undefined : emit('close')">
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
          <!-- Tarjeta de estado: la primera pregunta del detalle es la misma
               que la de la fila —¿corrió?— y acá se contesta con el motivo y
               la meta del run, no sólo con el glifo. -->
          <section class="state-card" :class="`is-${state}`">
            <ExecutionStatusLine
              class="state-line"
              :execution="execution ?? null"
              :attempts="attempts"
              :blocked="blocked"
              :runs-known="runsKnown"
              :pull-requests-known="pullRequestsKnown"
              :has-open-pr="!!openPr"
            />
            <p v-if="runMeta" class="state-meta">{{ runMeta }}</p>
          </section>

          <TaskExecutions
            v-if="open"
            :project-id="projectId"
            :task-id="taskId"
            :reload-token="runResult"
          />

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
              <p class="run-explain">
                Vuelve a evaluar las reglas contra el status
                <code v-if="status" class="run-status">{{ status }}</code>
                <span v-else class="run-status is-empty">sin status</span>
                sin mover la tarea en el board.
              </p>
            </div>
            <!-- Por qué correría o no, ANTES de apretar: un run que no
                 arranca no deja fila en Ejecuciones ni comentario en el
                 issue, así que sin esto no hay dónde mirar. -->
            <RunPreviewCard
              v-if="open"
              :project-id="projectId"
              :task-id="taskId"
              :reload-token="[runResult, moveToken]"
              :moving-status="movingStatus"
              @move="(st) => emit('move', st)"
            />
            <p v-if="runMessage" class="run-result" :class="{ 'is-error': !runMessage.ok }">
              {{ runMessage.text }}
            </p>
          </section>

          <!-- Pedir review es una acción SOBRE el PR, así que vive con las
               demás acciones de la tarea y no en la fila del listado, que es
               densa y de lectura. -->
          <section v-if="slackEnabled" class="slack-block">
            <span class="uc-label">Review</span>
            <button
              type="button"
              class="btn slack-btn"
              :disabled="!!slackBlockedReason || slackBusy"
              :title="slackBlockedReason ?? 'Taguea a los reviewers del repo en su canal de Slack'"
              @click="emit('slack-review')"
            >
              <span class="btn-glyph">{{ slackBusy ? '◐' : '✦' }}</span>
              {{ slackThreadUrl ? 'Pedir re-review' : 'Solicitar review en Slack' }}
            </button>
            <p v-if="slackBlockedReason" class="slack-why">{{ slackBlockedReason }}</p>
          </section>
        </div>

        <!-- Una acción principal por estado, no una fija: cuando algo está
             corriendo NO hay primary — no hay nada que iniciar. Orden neutro →
             primario → peligroso, con el destructivo último. -->
        <footer class="modal-foot">
          <template v-if="state === 'running'">
            <button class="btn foot-grow" @click="emit('logs')">Ver logs en vivo</button>
            <button
              class="btn btn--danger"
              :disabled="cancelling"
              @click="emit('cancel-run')"
            >
              {{ cancelling ? 'Abortando…' : 'Abortar' }}
            </button>
          </template>

          <template v-else-if="state === 'failed' || state === 'stopped'">
            <button class="btn" @click="emit('logs')">Logs</button>
            <button class="btn btn--primary foot-grow" :disabled="running" @click="emit('run')">
              {{ running ? 'Pidiendo…' : 'Reintentar' }}
            </button>
          </template>

          <template v-else-if="state === 'done'">
            <button class="btn" @click="emit('logs')">Logs</button>
            <button class="btn" :disabled="running" @click="emit('run')">
              {{ running ? 'Pidiendo…' : 'Correr' }}
            </button>
            <!-- Aprobar/mergear desde la app no existe todavía (ver Requisitos
                 de backend): la acción abre el PR en GitHub en vez de prometer
                 un botón que no hace nada. -->
            <a
              v-if="openPr"
              class="btn btn--primary foot-grow"
              :href="openPr.url"
              target="_blank"
              rel="noopener"
            >Ver PR #{{ openPr.number }} ↗</a>
          </template>

          <template v-else>
            <button class="btn btn--primary foot-grow" :disabled="running" @click="emit('run')">
              {{ running ? 'Pidiendo…' : '▷ Correr ahora' }}
            </button>
          </template>

          <button class="btn btn--ghost" @click="emit('close')">Cerrar</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.repos-block,
.slack-block,
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
.slack-btn { align-self: flex-start; }
.slack-why { margin: 0; font-size: var(--fs-micro); color: var(--fg-dim); }

.run-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
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
.run-result.is-error { color: var(--danger); }

/* La tarjeta de estado lleva la ranura del estado en el borde IZQUIERDO y su
   fondo: es lo primero que se mira, y el color tiene que llegar antes que el
   texto. */
.state-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  border-left: 2px solid var(--border-hi);
  border-radius: var(--radius);
  background: var(--panel-alt);
}
.state-card.is-running { border-left-color: var(--accent); background: var(--panel); }
.state-card.is-failed { border-left-color: var(--danger); background: var(--red-bg); }
.state-card.is-done { border-left-color: var(--accent); background: var(--green-bg); }
.state-card.is-stopped,
.state-card.is-idle { border-left-color: var(--warn); background: var(--yellow-bg); }
.state-line { font-size: var(--fs-body-sm); }
.state-meta { margin: 0; font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-dim); }

/* El botón que la pantalla existe para tocar ocupa el ancho que sobra; los
   demás miden lo suyo. */
.foot-grow { flex: 1; }

.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
/* Bajo 768px un detalle NO es un modal centrado: es la pantalla. Un modal con
   márgenes deja media pantalla de fondo inútil y el contenido apretado. */
.modal {
  background: var(--panel);
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

@media (min-width: 768px) {
  /* Panel lateral, no modal centrado: la lista NO se pierde al abrir una
     tarea, que es lo que permite recorrer varias seguidas. */
  .backdrop {
    justify-content: flex-end;
    background: rgba(0, 0, 0, 0.25);
  }
  .modal {
    width: 400px;
    max-width: 100%;
    height: 100%;
    border-left: 1px solid var(--border);
  }
}

/* ── Sobre --bp-split: segunda columna, no overlay ──────────────────────────
   Deja de flotar. Sin `fixed`, sin backdrop, sin z-index: es una caja más de
   la grilla, y la lista de al lado queda entera y usable — que es la
   diferencia entre "abrir una tarea" y "recorrer la cola".

   `sticky` para que el detalle acompañe el scroll de la lista en vez de
   quedarse arriba: con 40 tareas, un panel anclado al tope obliga a subir para
   leerlo. */
.backdrop--inline {
  position: sticky;
  top: calc(var(--tap-h) + 0.75rem);
  inset: auto;
  z-index: 1;
  display: block;
  background: none;
  max-height: calc(100vh - var(--tap-h) - 2rem);
}
.backdrop--inline .modal {
  width: 100%;
  height: auto;
  max-height: calc(100vh - var(--tap-h) - 2rem);
  border: 1px solid var(--border);
  border-radius: var(--radius);
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
  min-width: 0;
}
/* Sin esto, una línea que no envuelve (la de estado, que trunca con ellipsis)
   le impone su ancho de contenido al panel entero y el detalle scrollea en
   horizontal. `min-width: auto` es el default de un ítem flex, y es justo lo
   que hay que apagar para que el truncado ocurra DENTRO de la caja. */
.modal-body > * {
  min-width: 0;
  max-width: 100%;
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
