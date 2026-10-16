<script setup lang="ts">
import { type AssistantProposal, type AssistantProposalKind, proposalKind } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';
import { useGithubSessionStore } from '@/stores/githubSession';

// Lo que el asistente PROPONE —una acción sobre una tarea, abrir un issue, mover
// la card, sumar un issue al board o cambiarle labels—. No se ejecuta sola: el
// usuario la confirma con un botón y queda firmada con su login de GitHub. Sin
// login no sale ninguna request — se pide el login y la propuesta queda como estaba.

const props = defineProps<{
  proposal: AssistantProposal;
  status: 'open' | 'running' | 'done' | 'dismissed' | 'past';
  message?: string;
  /** Lo que se creó (el issue abierto). */
  url?: string;
  /** Las columnas del board al que se suma un issue (`proposal.board`), en orden: de qué elegir. */
  statuses?: string[];
  /** El issue se sumó al board: en qué columna quedó. */
  boardStatus?: string;
  /** El issue se abrió pero no quedó en el board, y por qué. No se reintenta: duplicaría el issue. */
  boardError?: string;
  error?: string;
}>();

/** Cómo se nombra cada tipo en la card: el rótulo, el botón y lo que dice al terminar. */
const COPY: Record<AssistantProposalKind, { kind: string; run: string; running: string; done: string }> = {
  action: { kind: 'acción propuesta', run: 'Ejecutar', running: 'Ejecutando…', done: 'Ejecutada' },
  issue: { kind: 'issue propuesto', run: 'Abrir issue', running: 'Abriendo…', done: 'Abierto' },
  move: { kind: 'mover la card', run: 'Mover', running: 'Moviendo…', done: 'Movida' },
  add_to_board: { kind: 'sumar al board', run: 'Agregar al board', running: 'Agregando…', done: 'Agregada' },
  labels: { kind: 'cambiar labels', run: 'Aplicar', running: 'Aplicando…', done: 'Aplicado' },
};

const kind = computed(() => proposalKind(props.proposal));
const copy = computed(() => COPY[kind.value]);

/** La propuesta, si es de ese tipo. */
function ofKind<K extends Exclude<AssistantProposalKind, 'action'>>(wanted: K) {
  return computed(() =>
    kind.value === wanted ? (props.proposal as Extract<AssistantProposal, { kind: K }>) : null,
  );
}
const issue = ofKind('issue');
/** El issue va además al board: se crea y se suma en una sola confirmación. */
const board = computed(() => issue.value?.board ?? null);
const runLabel = computed(() => {
  const [running, idle] = board.value
    ? ['Creando…', 'Crear y agregar al board']
    : [copy.value.running, copy.value.run];
  return props.status === 'running' ? running : idle;
});

/** La columna de entrada de un board: «Todo» (o «To do»), si el board la tiene. */
const isTodo = (column: string) => column.toLowerCase().replace(/\s+/g, '') === 'todo';
/** La que propuso el asistente si existe en el board; si no, Todo; si no, la primera. Sin columnas
 *  conocidas, la propuesta tal cual (sin ella, el runner usa Todo). */
function initialColumn(): string | undefined {
  const columns = props.statuses ?? [];
  const wanted = board.value?.status;
  if (!columns.length) return wanted;
  if (wanted && columns.includes(wanted)) return wanted;
  return columns.find(isTodo) ?? columns[0];
}
const column = ref(initialColumn());
// Las columnas llegan con la bandeja, quizás después que la propuesta: lo elegido se respeta.
watch(
  () => props.statuses,
  (columns) => {
    if (!column.value || !(columns ?? []).includes(column.value)) column.value = initialColumn();
  },
);
const pickColumn = computed(() => !!board.value && !!props.statuses?.length && (props.status === 'open' || props.status === 'running'));

/** `https://github.com/o/r/issues/7` → `o/r#7`: cómo se nombra el issue abierto. */
const openedRef = computed(() => {
  const m = props.url ? /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(props.url) : null;
  return m ? `${m[1]}/${m[2]}#${m[3]}` : (props.url ?? issue.value?.repo ?? '');
});

function run() {
  if (board.value) emit('run', column.value ? { status: column.value } : {});
  else emit('run');
}
const move = ofKind('move');
const adding = ofKind('add_to_board');
const labels = ofKind('labels');
/** La tarea del board de la que habla (la abre en la bandeja). Un issue a sumar todavía no está. */
const taskRef = computed(() => ('ref' in props.proposal ? props.proposal.ref : null));
const comment = computed(() => ('comment' in props.proposal ? props.proposal.comment : undefined));
/** El link del issue a sumar: no está en la bandeja, se abre en GitHub. */
const issueUrl = computed(() => {
  const m = adding.value ? /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(adding.value.issue) : null;
  return m ? `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}` : undefined;
});

const emit = defineEmits<{
  (e: 'run', choice?: { status?: string }): void;
  (e: 'dismiss'): void;
  (e: 'open', ref: string): void;
}>();

const session = useGithubSessionStore();
</script>

<template>
  <div class="pc" :data-status="status">
    <p class="uc-label pc__kind">{{ copy.kind }}</p>
    <p v-if="taskRef" class="pc__what">
      <strong>{{ proposal.label }}</strong>
      <!-- La tarea de la propuesta no se repite como card: su ref la abre en la bandeja. -->
      <button type="button" class="pc__ref mono" :data-test="`open-${taskRef}`" @click="emit('open', taskRef)">
        {{ taskRef }} →
      </button>
    </p>
    <template v-else-if="issue">
      <p class="pc__what">
        <strong data-test="issue-title">{{ issue.title }}</strong>
        <span class="pc__repo mono">{{ issue.repo }}</span>
      </p>
      <p v-if="issue.labels?.length" class="pc__labels mono">{{ issue.labels.join(' · ') }}</p>
      <!-- Al board, en la columna que elija la persona (preseleccionada la propuesta, o Todo). -->
      <label v-if="board && pickColumn" class="pc__col">
        <span class="uc-label">Columna</span>
        <select v-model="column" class="mono" data-test="board-column" :disabled="status === 'running'">
          <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
        </select>
        <span class="pc__repo mono">{{ board.project_id }}</span>
      </label>
      <p v-else-if="board && status !== 'done'" class="pc__change mono" data-test="board">
        → <strong>{{ column ?? 'columna de entrada' }}</strong> · {{ board.project_id }}
      </p>
    </template>
    <p v-else-if="adding" class="pc__what">
      <strong>{{ proposal.label }}</strong>
      <a class="pc__ref mono" :href="issueUrl" target="_blank" rel="noopener" data-test="issue-link">{{ adding.issue }} ↗</a>
    </p>
    <!-- Qué cambia en el board, en una línea: de dónde a dónde, o qué labels van y vienen. -->
    <p v-if="move" class="pc__change mono" data-test="move">
      {{ move.from ?? 'sin columna' }} → <strong>{{ move.status }}</strong>
    </p>
    <p v-else-if="adding" class="pc__change mono" data-test="add">
      → <strong>{{ adding.status ?? 'columna de entrada' }}</strong><template v-if="adding.project_id"> · {{ adding.project_id }}</template>
    </p>
    <p v-else-if="labels" class="pc__change mono" data-test="labels">
      <span v-for="label in labels.add ?? []" :key="`+${label}`" class="pc__tag">+ {{ label }}</span>
      <span v-for="label in labels.remove ?? []" :key="`-${label}`" class="pc__tag pc__tag--off">− {{ label }}</span>
    </p>
    <!-- Lo dijo el modelo: `--fg-mute`, nunca un color de estado (R16). -->
    <p class="pc__why"><span class="pc__ai" aria-hidden="true">✦</span> {{ proposal.reason }}</p>
    <blockquote v-if="comment" class="pc__comment">{{ comment }}</blockquote>
    <!-- El cuerpo del issue, tal como se va a abrir: plegado, para leerlo antes de confirmar. -->
    <details v-if="issue" class="pc__body">
      <summary>Ver el cuerpo</summary>
      <blockquote class="pc__comment" data-test="issue-body">{{ issue.body }}</blockquote>
    </details>

    <div v-if="status === 'open' || status === 'running'" class="pc__row">
      <button
        v-if="session.github"
        type="button"
        class="btn btn--primary"
        data-test="run"
        :disabled="status === 'running'"
        @click="run"
      >
        {{ runLabel }}
      </button>
      <button v-else type="button" class="btn btn--primary" data-test="login" @click="session.requestLogin()">
        Iniciar sesión con GitHub
      </button>
      <button type="button" class="btn" data-test="dismiss" :disabled="status === 'running'" @click="emit('dismiss')">
        Descartar
      </button>
    </div>
    <p v-if="!session.github && status === 'open'" class="pc__hint">
      → Para ejecutarla tenés que iniciar sesión: queda firmada con tu usuario de GitHub.
    </p>

    <p v-if="status === 'done' && board && boardStatus" class="pc__done" role="status" data-test="done">
      ✓ <a v-if="url" class="pc__link link" :href="url" target="_blank" rel="noopener">{{ openedRef }}</a><template v-else>{{ openedRef }}</template>
      abierto y en {{ boardStatus }}
    </p>
    <template v-else-if="status === 'done' && board">
      <p class="pc__done" role="status" data-test="done">
        ✓ <a v-if="url" class="pc__link link" :href="url" target="_blank" rel="noopener">{{ openedRef }}</a><template v-else>{{ openedRef }}</template>
        abierto
      </p>
      <!-- Abierto pero fuera del board: sin «Reintentar», que abriría otro issue igual. -->
      <p v-if="boardError" class="pc__warn" role="alert" data-test="board-error">
        ⚠ No quedó en el board: {{ boardError }}. Sumalo desde GitHub; no lo vuelvas a crear.
      </p>
    </template>
    <p v-else-if="status === 'done' && issue" class="pc__done" role="status">
      ✓ Abierto<template v-if="url"> · <a class="pc__link link" :href="url" target="_blank" rel="noopener">{{ message ?? url }}</a></template>
    </p>
    <p v-else-if="status === 'done'" class="pc__done" role="status">✓ {{ copy.done }}<template v-if="message"> · {{ message }}</template></p>
    <p v-else-if="status === 'dismissed'" class="pc__dim">Descartada.</p>
    <!-- De una conversación retomada: la tarea pudo cambiar desde entonces. Se actúa desde la bandeja. -->
    <p v-else-if="status === 'past'" class="pc__dim">De una conversación anterior: si todavía aplica, hacelo desde la bandeja.</p>
    <p v-if="error" class="pc__err" role="alert">✕ {{ error }}</p>
  </div>
</template>

<style scoped>
.pc { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.6rem 0.75rem; border: 1px solid var(--accent); border-radius: var(--radius); background: var(--panel-alt); }
.pc[data-status='dismissed'],
.pc[data-status='past'] { border-color: var(--border); opacity: 0.7; }
.pc p { margin: 0; overflow-wrap: anywhere; }
.pc__kind { color: var(--fg-dim); }
.pc__what { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.5rem; color: var(--fg); }
/* Link de texto en la línea: el blanco táctil lo da el alto (R1), no una caja. */
.pc__ref { min-height: var(--tap-h); padding: 0; border: 0; background: none; color: var(--info); font-size: var(--fs-body-sm); text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.pc__ref:hover { text-decoration: underline; }
.pc__repo { color: var(--fg-dim); font-size: var(--fs-micro); }
.pc__labels { color: var(--fg-dim); font-size: var(--fs-micro); }
.pc__change { display: flex; flex-wrap: wrap; gap: 0.25rem 0.6rem; color: var(--fg-dim); font-size: var(--fs-body-sm); }
.pc__change strong { color: var(--fg); font-weight: 600; }
.pc__tag { color: var(--fg); }
.pc__tag--off { color: var(--fg-mute); text-decoration: line-through; }
.pc__body summary { display: list-item; line-height: var(--tap-h); color: var(--info); font-size: var(--fs-body-sm); cursor: pointer; }
.pc__link { overflow-wrap: anywhere; }
.pc__why { color: var(--fg-mute); font-size: var(--fs-body-sm); line-height: 1.45; }
.pc__ai { color: var(--ai); }
.pc__comment { margin: 0; padding: 0.4rem 0.6rem; border-left: 2px solid var(--ai); background: var(--panel); color: var(--fg-mute); font-size: var(--fs-body-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
.pc__row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.15rem; }
.pc__hint { color: var(--info); font-size: var(--fs-body-sm); }
.pc__done { color: var(--accent); font-size: var(--fs-body-sm); font-weight: 600; }
.pc__dim { color: var(--fg-dim); font-size: var(--fs-body-sm); }
.pc__col { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.6rem; }
.pc__col select { min-height: var(--tap-h); max-width: 100%; }
.pc__warn { color: var(--warn); font-size: var(--fs-body-sm); }
.pc__err { color: var(--danger); font-size: var(--fs-body-sm); }
</style>
