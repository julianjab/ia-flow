<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { formatRelative } from '@/composables/formatRelative';
import { useNow } from '@/composables/useNow';
import { checkHealth } from '@/features/runner-health/api';
import HealthSummary from '@/features/runner-health/HealthSummary.vue';
import { clockOf } from '@/features/runner-health/logs';
import { recentProblems, rowsOf } from '@/features/runner-health/rows';
import { type HealthSnapshot, issuesOf, type Occupancy, type Tone, verdictOf } from '@/features/runner-health/status';
import { usePoll } from '@/features/runner-health/usePoll';
import LogLine from '@/ui/LogLine.vue';

// «Estado del runner», como en el menú de Mac: primero lo que está mal, después una fila por cosa
// —responde, capacidad, memoria, disco, hosts, entradas, asistente— y los últimos avisos del log.
// Se relee cada 6 s mientras está abierta. Si deja de responder, lo último que se vio queda abajo,
// atenuado. La ocupación la pone quien la monta (la bandeja ya la tiene).

const props = defineProps<{
  /** El runner, para decir quién no responde. */
  host: string;
  occupancy?: Occupancy | null;
}>();

const POLL_MS = 6000;

/** Lo último que se revisó, responda o no. */
const latest = ref<HealthSnapshot | null>(null);
/** Lo último que se vio con el runner respondiendo. */
const lastGood = ref<HealthSnapshot | null>(null);

const poll = usePoll(async () => {
  const snapshot = await checkHealth();
  latest.value = snapshot;
  if (snapshot.alive) lastGood.value = snapshot;
}, POLL_MS);

const { now } = useNow();
const down = computed(() => latest.value?.alive === false);
const shown = computed(() => (down.value ? lastGood.value : latest.value));
const issues = computed(() => (latest.value ? issuesOf(latest.value, props.occupancy, now.value) : []));
const verdict = computed(() => (latest.value ? verdictOf(latest.value, issues.value, props.occupancy) : null));
const rows = computed(() => (shown.value ? rowsOf(shown.value, props.occupancy, now.value) : []));
const problems = computed(() => (shown.value ? recentProblems(shown.value) : []));
const checked = computed(() => {
  if (!latest.value) return '';
  const ago = formatRelative(new Date(latest.value.checkedAt).toISOString(), now.value);
  return ago === 'ahora' ? 'revisado ahora' : `revisado ${ago}`;
});

const GLYPH: Record<Tone, string> = { ok: '✓', warn: '!', bad: '✕', info: '·', off: '○' };
</script>

<template>
  <div class="rh">
    <p v-if="checked" class="rh__checked" data-test="checked">{{ checked }}</p>

    <div v-if="!latest" class="rh__loading" aria-busy="true">
      <span class="sr-only">Revisando {{ host }}…</span>
      <span class="skeleton rh__sk rh__sk--box" aria-hidden="true" />
      <span v-for="i in 5" :key="i" class="skeleton rh__sk" aria-hidden="true" />
    </div>

    <div v-else-if="down" class="rh__err" role="alert" data-test="down">
      <p><b>{{ host }} no responde</b><template v-if="latest.failure">: {{ latest.failure }}</template></p>
      <p class="rh__fix">→ Puede estar reiniciando.<template v-if="lastGood"> Lo último que se vio queda abajo, atenuado.</template></p>
      <div class="rh__row">
        <button type="button" class="btn" @click="poll.now()">Reintentar</button>
        <RouterLink to="/servers" class="btn btn--ghost">Cambiar de runner</RouterLink>
      </div>
    </div>

    <HealthSummary v-else-if="verdict" :snapshot="latest" :issues="issues" :verdict="verdict" />

    <div v-if="shown" class="rh__body" :class="{ 'rh__body--stale': down }">
      <ul class="rh__list" aria-label="Estado">
        <li v-for="row in rows" :key="row.id" class="rh__item" :data-test="`row-${row.id}`">
          <span class="rh__glyph" :class="`rh__glyph--${row.tone}`" aria-hidden="true">{{ GLYPH[row.tone] }}</span>
          <span class="rh__text">
            <span class="rh__label">{{ row.label }}</span>
            <span class="rh__detail">{{ row.detail }}</span>
          </span>
        </li>
      </ul>

      <section v-if="problems.length" class="rh__problems" aria-labelledby="rh-problems">
        <h2 id="rh-problems" class="rh__hd">Últimos avisos</h2>
        <div class="rh__logs" data-test="problems">
          <LogLine
            v-for="line in problems"
            :key="line.seq"
            :time="clockOf(line.time)"
            :level="line.level"
            :origin="line.scope"
            :message="line.message"
          />
        </div>
      </section>
    </div>

    <div v-if="latest" class="rh__row">
      <button type="button" class="btn" data-test="recheck" @click="poll.now()">Revisar de nuevo</button>
      <RouterLink :to="{ name: 'logs' }" class="btn" data-test="to-logs">Ver logs del server</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.rh { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
.rh__checked { margin: 0; color: var(--fg-dim); font-size: var(--fs-chrome); }
.rh__loading { display: flex; flex-direction: column; gap: 0.5rem; }
.rh__sk { width: 100%; }
.rh__sk--box { height: 4.5rem; border-radius: var(--radius-lg); }

.rh__err { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.85rem 1rem; border: 1px solid var(--danger); border-radius: var(--radius-lg); background: var(--red-bg); }
.rh__err p { margin: 0; overflow-wrap: anywhere; }
.rh__fix { color: var(--info); font-size: var(--fs-body-sm); }

.rh__body { display: flex; flex-direction: column; gap: 0.75rem; }
.rh__body--stale { opacity: 0.35; }

/* Una lista de filas de lectura: no se tocan, así que miden lo que el texto pide (R11). */
.rh__list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel-alt); overflow: hidden; }
.rh__item { display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.6rem 1rem; }
.rh__item + .rh__item { border-top: 1px solid var(--border-mute); }
.rh__glyph { flex: none; width: 1ch; font-weight: 700; text-align: center; color: var(--fg-dimmer); }
.rh__glyph--ok { color: var(--accent); }
.rh__glyph--warn { color: var(--warn); }
.rh__glyph--bad { color: var(--danger); }
.rh__text { display: flex; flex-direction: column; min-width: 0; }
.rh__label { color: var(--fg); }
.rh__detail { color: var(--fg-dim); font-size: var(--fs-chrome); overflow-wrap: anywhere; }

.rh__problems { display: flex; flex-direction: column; gap: 0.4rem; }
.rh__hd { margin: 0; font-size: var(--fs-body); font-weight: 600; }
.rh__logs { padding: 0.35rem 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg); }

.rh__row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
/* Un link con caja de botón: el `:hover` completo, sin el subrayado del link de texto. */
.rh__row a.btn:hover { text-decoration: none; }
</style>
