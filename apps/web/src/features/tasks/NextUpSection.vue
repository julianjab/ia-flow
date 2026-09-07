<script setup lang="ts">
import {
  DISPOSITION_ORDER,
  type TaskDisposition,
  type TaskDispositionEntry,
  type TaskVerb,
} from '@ia-flow/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import BucketHeader from '@/components/BucketHeader.vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { useProjectsStore } from '@/features/projects/store';
import { fetchProjectItems, type SourceItem } from '@/features/projects/sourceApi';
import { fetchTaskDispositions, runTaskNow } from '@/features/tasks/api';
import { useToastStore } from '@/stores/toast';

/**
 * "Qué sigue" — la pantalla que ES el orden.
 *
 * La cola se ordenaba en el CLIENTE con una heurística de cinco niveles sobre
 * el último run y los blockers. No podía hacer más: no conoce las reglas, así
 * que un fallo con regla de retry y uno sin ella le daban idénticos — y esa
 * distinción es justamente la que separa "te espera" de "avanza solo".
 *
 * Ahora la disposición, su razón y el verbo los resuelve el server
 * (`GET /api/tasks/dispositions`) y esta pantalla los dibuja. Lo que queda acá
 * es lo que sí es de la UI: agrupar por bucket, y **congelar el orden**.
 */

const projectsStore = useProjectsStore();
const toastStore = useToastStore();
const router = useRouter();

const items = ref<SourceItem[]>([]);
const dispositions = ref<TaskDispositionEntry[]>([]);
/** El agregado no se pudo consultar. NO es lo mismo que "nada te espera": sin
 *  él la pantalla no puede afirmar nada sobre el proyecto. */
const dispositionsFailed = ref(false);
const loading = ref(false);
const error = ref('');
const running = ref<Set<string>>(new Set());

const activeProjectId = computed(() => projectsStore.activeProjectId);

interface Row {
  id: string;
  title: string;
  issueNumber?: number;
  url?: string;
  disposition: TaskDisposition;
  reason: string;
  verb: TaskVerb | null;
}

/**
 * El orden congelado.
 *
 * Un orden que depende del estado se reordena solo, y con el socket vivo eso
 * significa que la fila que ibas a tocar se mueve bajo el dedo. **El orden se
 * calcula al abrir la pantalla y no se recalcula solo**: los datos nuevos
 * cambian el CONTENIDO de la fila donde está, y arriba aparece
 * `N cambiaron de lugar · reordenar`. Reordenar es un gesto del usuario.
 *
 * Es una lista de ids y no un snapshot de las filas: así una fila que cambió
 * de razón se re-dibuja al instante —que es información útil— sin moverse.
 */
const frozenOrder = ref<string[]>([]);

/** Las filas tal como el server las devolvió, ya ordenadas por él. */
const serverOrder = computed(() => dispositions.value.map((d) => d.taskId));

/** Cuántas cambiarían de lugar si se reordenara ahora. Cero ⇒ no se dibuja el
 *  aviso: un cartel que dice "nada cambió" es chrome. */
const movedCount = computed(() => {
  const frozen = frozenOrder.value;
  const next = serverOrder.value;
  if (!frozen.length) return 0;
  let moved = 0;
  for (let i = 0; i < next.length; i++) {
    if (frozen[i] !== next[i]) moved++;
  }
  return moved;
});

function applyNewOrder() {
  frozenOrder.value = [...serverOrder.value];
}

async function load() {
  const pid = activeProjectId.value;
  dispositionsFailed.value = false;
  dispositions.value = [];
  if (!pid) return;
  loading.value = true;
  error.value = '';
  try {
    const res = await fetchProjectItems(pid);
    if (activeProjectId.value !== pid) return;
    if (res.error) {
      error.value = res.error;
      return;
    }
    items.value = res.items ?? [];
    try {
      const next = await fetchTaskDispositions(pid);
      if (activeProjectId.value !== pid) return;
      dispositions.value = next;
      // Primera carga: el orden se congela acá. Las siguientes NO lo pisan —
      // ése es todo el punto.
      if (!frozenOrder.value.length) applyNewOrder();
    } catch {
      if (activeProjectId.value !== pid) return;
      dispositionsFailed.value = true;
    }
  } catch (e) {
    if (activeProjectId.value === pid) error.value = extractErrorMessage(e);
  } finally {
    if (activeProjectId.value === pid) loading.value = false;
  }
}

onMounted(load);
watch(activeProjectId, () => {
  items.value = [];
  frozenOrder.value = [];
  void load();
});

const itemsById = computed(() => new Map(items.value.map((i) => [i.id, i])));

/** Las filas en el orden CONGELADO. Una tarea nueva que el orden viejo no
 *  conoce va al final: meterla en su lugar sería reordenar sin permiso. */
const rows = computed<Row[]>(() => {
  const byId = new Map(dispositions.value.map((d) => [d.taskId, d]));
  const seen = new Set<string>();
  const ordered: TaskDispositionEntry[] = [];
  for (const id of frozenOrder.value) {
    const d = byId.get(id);
    if (d) {
      ordered.push(d);
      seen.add(id);
    }
  }
  for (const d of dispositions.value) if (!seen.has(d.taskId)) ordered.push(d);

  return ordered.map((d) => {
    const item = itemsById.value.get(d.taskId);
    return {
      id: d.taskId,
      title: item?.title ?? d.taskId,
      issueNumber: item?.meta?.issueNumber as number | undefined,
      url: item?.meta?.issueUrl as string | undefined,
      disposition: d.disposition,
      reason: d.reason,
      verb: d.verb,
    };
  });
});

/** Agrupadas por bucket, en el orden de los cuatro. Un bucket vacío no se
 *  dibuja — su encabezado sería chrome que cuenta cero (R10). */
const buckets = computed(() =>
  DISPOSITION_ORDER.map((disposition) => ({
    disposition,
    rows: rows.value.filter((r) => r.disposition === disposition),
  })).filter((b) => b.rows.length > 0),
);

/** `cerrado` arranca plegado (O4). */
const closedOpen = ref(false);

/**
 * El verbo de una fila.
 *
 * Ninguna fila inventa una capacidad: el server ya decidió el DESTINO, y acá
 * sólo se despacha. `external` y `route` son navegación; `run` es el único que
 * llama a un endpoint, y es el único que existe hoy en la app.
 */
async function fire(row: Row) {
  const verb = row.verb;
  const pid = activeProjectId.value;
  if (!verb || !pid) return;
  if (verb.kind === 'external' && verb.href) {
    window.open(verb.href, '_blank', 'noopener');
    return;
  }
  if (verb.kind === 'route' && verb.href) {
    void router.push(verb.href);
    return;
  }
  if (verb.kind !== 'run' || running.value.has(row.id)) return;
  running.value = new Set([...running.value, row.id]);
  try {
    const res = await runTaskNow(pid, row.id);
    // Los tres outcomes se dicen literales: "ninguna regla matcheó tu status"
    // no es un fallo del server, es config para revisar, y esconderla dejaría
    // al operador esperando un run que nunca va a arrancar.
    if (res.outcome === 'dispatched') toastStore.success(`${row.title}: despachada`);
    else if (res.outcome === 'deferred') {
      toastStore.success(`${row.title}: en cola por capacidad`);
    } else {
      toastStore.error(`Ninguna regla matcheó el status "${res.status}"`);
    }
    await load();
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  } finally {
    const next = new Set(running.value);
    next.delete(row.id);
    running.value = next;
  }
}

function openTasks() {
  void router.push(`/projects/${activeProjectId.value}/tareas`);
}
</script>

<template>
  <section class="settings-section settings-section--list">
    <!-- Sin `<h2>Qué sigue</h2>`: la barra de identidad del shell ya lo dice
         (R9). La descripción SÍ queda: explica el criterio de orden, que es lo
         único que no se deduce mirando las filas. -->
    <div class="nu-top">
      <p class="section-desc nu-desc">
        Quién tiene que mover la próxima pieza. No es un orden por fecha: lo más
        reciente es casi siempre lo que avanza sin vos.
      </p>
      <div class="nu-top-actions">
        <span class="nu-count">{{ rows.length }} de {{ items.length }}</span>
        <button type="button" class="btn" :disabled="loading" @click="load()">
          <span class="btn-glyph">{{ loading ? '◐' : '↺' }}</span>
          {{ loading ? 'Cargando…' : 'Actualizar' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="nu-error">
      <p class="nu-error-line"><span class="nu-glyph">✕</span>{{ error }}</p>
      <p class="nu-error-fix"><span class="nu-glyph">→</span>Revisá el provider del proyecto y volvé a intentar.</p>
    </div>

    <p v-else-if="loading && !rows.length" class="nu-empty">Cargando…</p>
    <!-- Lo que no se pudo consultar se declara ANTES de mostrar (o no mostrar)
         filas: una cola incompleta que se lee como completa es peor que un
         error, porque no se nota. -->
    <p v-else-if="dispositionsFailed" class="nu-degraded">
      No se pudo consultar el estado de las tareas: esta cola está incompleta.
    </p>
    <p v-else-if="!rows.length" class="nu-empty">
      No hay tareas en este proyecto.
    </p>

    <template v-if="!error && rows.length">
      <!-- El orden NO se recalcula solo: si lo hiciera, la fila que ibas a
           tocar se movería bajo el dedo cada vez que llega un evento.
           Reordenar es un gesto tuyo. -->
      <button
        v-if="movedCount > 0"
        type="button"
        class="nu-moved"
        data-testid="next-up-reorder"
        @click="applyNewOrder"
      >
        {{ movedCount }} {{ movedCount === 1 ? 'cambió' : 'cambiaron' }} de lugar
        <span class="nu-moved-sep">·</span>
        <span class="nu-moved-cta">reordenar</span>
      </button>

      <div v-for="bucket in buckets" :key="bucket.disposition" class="nu-bucket">
        <BucketHeader
          :disposition="bucket.disposition"
          :count="bucket.rows.length"
          :collapsible="bucket.disposition === 'closed'"
          :open="closedOpen"
          @toggle="closedOpen = !closedOpen"
        />

        <ul
          v-if="bucket.disposition !== 'closed' || closedOpen"
          class="nu-list"
          data-kbd-list="next-up"
        >
          <li v-for="row in bucket.rows" :key="row.id" class="nu-row">
            <div class="nu-body">
              <p class="nu-title">
                {{ row.title }}
                <a
                  v-if="row.issueNumber && row.url"
                  class="nu-issue"
                  :href="row.url"
                  target="_blank"
                  rel="noopener"
                  @click.stop
                >#{{ row.issueNumber }}</a>
                <span v-else-if="row.issueNumber" class="nu-issue is-plain">#{{ row.issueNumber }}</span>
              </p>
              <!-- La razón viaja con la fila (O1): nunca dice sólo su estado,
                   dice por qué está en su bucket. -->
              <p class="nu-reason" :class="`is-${row.disposition}`">{{ row.reason }}</p>
              <!-- El verbo sólo en el bucket 1 (O2): en los otros tres, si no
                   te toca, ofrecer un botón es ruido. El destino lo decidió el
                   server; acá sólo se despacha. -->
              <button
                v-if="row.verb"
                type="button"
                class="nu-verb"
                :disabled="running.has(row.id)"
                data-testid="next-up-verb"
                @click="fire(row)"
              >
                → {{ running.has(row.id) ? 'Despachando…' : row.verb.label }}
                <span v-if="row.verb.hint" class="nu-verb-hint">{{ row.verb.hint }}</span>
              </button>
            </div>
          </li>
        </ul>
      </div>

      <button type="button" class="btn btn--ghost nu-all" @click="openTasks">
        ver las {{ items.length }} tareas →
      </button>
    </template>
  </section>
</template>

<style scoped>
.nu-count {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  white-space: nowrap;
}
.btn-glyph { color: var(--fg-dim); }
.nu-head { display: block; }
.nu-empty { margin: 0; font-size: var(--fs-body-sm); color: var(--fg-dim); }
/* Degradación, no error: el fetch de tareas anduvo, el de runs no. */
.nu-degraded { margin: 0; font-size: var(--fs-body-sm); color: var(--warn); }

.nu-error { display: flex; flex-direction: column; gap: 0.15rem; font-family: var(--font-mono); font-size: var(--fs-micro); }
.nu-error-line { margin: 0; color: var(--danger); overflow-wrap: anywhere; }
.nu-error-fix { margin: 0; color: var(--info); }
.nu-glyph { display: inline-block; width: 1.4ch; }

.nu-top { display: flex; align-items: flex-start; gap: 1rem; }
.nu-desc { flex: 1 1 auto; min-width: 0; margin: 0; }
.nu-top-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 0.5rem; }

/* El aviso de reorden: información, no alarma. Va en --info porque describe el
   estado del ORDEN, no el de una tarea. */
.nu-moved {
  display: flex;
  align-items: center;
  gap: 0.5ch;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0 1rem;
  border: none;
  background: var(--panel-alt);
  color: var(--info);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  text-align: left;
  cursor: pointer;
}
.nu-moved:hover { background: var(--panel-hi); }
.nu-moved-sep { color: var(--fg-dimmer); }
.nu-moved-cta { text-decoration: underline; }

.nu-bucket { display: flex; flex-direction: column; }
.nu-list { list-style: none; margin: 0; padding: 0; }
/* Sin zebra: la cola se lee de arriba abajo una vez, no se escanea como una
   tabla. El hairline alcanza para separar. */
/* Sin número de puesto: el bucket ya dice de qué grupo es la fila, y numerar
   dentro de un grupo de tres invitaba a leer "el 1" como una prioridad
   absoluta que se movía sola entre cargas. */
.nu-row {
  display: flex;
  padding: 0.5rem 1rem;
}
.nu-row + .nu-row { border-top: 1px solid var(--border-mute); }
.nu-body { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.nu-title {
  margin: 0;
  font-size: var(--fs-body);
  line-height: 1.4;
  color: var(--fg);
  text-wrap: pretty;
  overflow-wrap: anywhere;
}
.nu-issue {
  margin-left: 0.35rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
  text-decoration: none;
}
/* Sin esto el `a:hover` global lo pinta de teal entero. */
.nu-issue:hover:not(.is-plain) { background: transparent; color: var(--info); }

.nu-reason {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}
.nu-reason.is-waiting-on-you { color: var(--danger); }
.nu-reason.is-blocked { color: var(--warn); }
.nu-reason.is-moving { color: var(--accent); }
.nu-reason.is-closed { color: var(--fg-dimmer); }

/* Cada fila del bucket 1 termina en un verbo (O2), y el verbo se toca:
   --tap-h de área. El `hint` dice a DÓNDE lleva —`↗ github`, `· runs
   abortados`— que es lo que evita que prometa de más. */
.nu-verb {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  min-height: var(--tap-h);
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.nu-verb:hover:not(:disabled) { text-decoration: underline; }
.nu-verb:disabled { color: var(--fg-dim); cursor: progress; }
.nu-verb-hint { color: var(--fg-dimmer); font-size: var(--fs-micro); }

.nu-all { align-self: flex-start; font-family: var(--font-mono); }
</style>
