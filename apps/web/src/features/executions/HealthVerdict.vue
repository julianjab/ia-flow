<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { type ExecutionStats, fetchExecutionStats } from './api';
import { compactTokens, formatUsd, percent, WINDOWS } from './health-format';
import { type DispositionCount, dispositionCounts, summarizeHealth } from './verdict';

/**
 * El resumen de la pantalla de ejecuciones — un veredicto, no una tabla (R10).
 *
 * Reemplaza al `AgentHealthPanel` en la cabecera. Aquél medía 418px y ponía la
 * primera fila de runs a 610px del borde: en un teléfono de 800, una fila y
 * media visible. Esto mide ~123px y la primera fila queda a 246 — siete filas.
 *
 * Pero el alto es la consecuencia, no la razón. Una tabla de diez columnas por
 * agente contesta "¿cuánto cuesta cada uno?", que es una pregunta de auditoría;
 * la pregunta de una pantalla de vigilancia es "¿a cuál tengo que mirar?". Por
 * eso acá sólo se nombran los agentes **fuera de banda**, con su razón literal,
 * y el resto se cuenta. La tabla no se recortó a tres columnas: se mudó entera
 * a la pantalla del agente, que es donde se audita — una fila de acá lleva ahí.
 *
 * Las reglas de quién está fuera de banda viven en `verdict.ts`, puras.
 */
const props = defineProps<{ projectId?: string | null; outcomeCounts: Record<string, number> }>();

const emit = defineEmits<{
  /** Un contador prende su filtro: el contador ES el filtro, un atajo y no un
   *  segundo camino. */
  (e: 'filter', outcomes: string[]): void;
  /** Una línea abre la página del agente. La navegación la hace el padre, que
   *  es quien sabe en qué scope estamos. */
  (e: 'open', agentId: string): void;
}>();

const windowDays = ref<number>(7);
const stats = ref<ExecutionStats | null>(null);
const loading = ref(false);
const error = ref('');
/** Los sanos arrancan plegados: son, literalmente, la parte que no hay que
 *  mirar (O4). */
const healthyOpen = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const from = new Date(Date.now() - windowDays.value * 24 * 60 * 60 * 1000).toISOString();
    stats.value = await fetchExecutionStats({
      from,
      ...(props.projectId ? { projectId: props.projectId } : {}),
    });
  } catch (err) {
    error.value = extractErrorMessage(err);
    stats.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => [props.projectId, windowDays.value], load);

const counts = computed<DispositionCount[]>(() => dispositionCounts(props.outcomeCounts));
const verdict = computed(() => summarizeHealth(stats.value?.agents ?? []));
const totals = computed(() => stats.value?.totals ?? null);

/**
 * El párrafo explicativo del panel viejo, ahora en el `title` de la línea de
 * totales: describe cómo se calculan estos números, que es algo que se lee una
 * vez y después ocupa dos renglones para siempre.
 */
const totalsTitle =
  'Runs terminados en la ventana. La tasa se calcula en el servidor sobre todo el período, ' +
  'no sobre la página del listado.';
</script>

<template>
  <div class="hv">
    <!-- Tres contadores por disposición, no seis outcomes: la pregunta es quién
         mueve la próxima pieza. El de "te esperan" es el único en --danger,
         porque es el único que pide algo. Un cero no se dibuja (R10). -->
    <div v-if="counts.length" class="hv__counts" aria-label="Resumen por disposición">
      <button
        v-for="c in counts"
        :key="c.key"
        type="button"
        class="hv__count"
        :class="`hv__count--${c.key}`"
        :data-testid="`verdict-count-${c.key}`"
        :title="`Filtrar por ${c.label}`"
        @click="emit('filter', c.outcomes)"
      >
        <b>{{ c.count }}</b> {{ c.label }}
      </button>
    </div>

    <p v-if="error" class="hv__error">{{ error }}</p>
    <template v-else-if="stats">
      <p v-if="totals" class="hv__totals" :title="totalsTitle">
        <strong>{{ totals.runs }}</strong> runs ·
        <strong>{{ percent(totals.successRate) }}</strong> ok ·
        {{ compactTokens(totals.tokensIn) }} frescos ·
        <strong>{{ formatUsd(totals.costUsd) }}</strong> est.
        <span class="hv__windows">
          <button
            v-for="w in WINDOWS"
            :key="w.days"
            type="button"
            class="hv__window"
            :class="{ 'hv__window--on': windowDays === w.days }"
            :aria-pressed="windowDays === w.days"
            @click="windowDays = w.days"
          >{{ w.label }}</button>
        </span>
      </p>

      <!-- Un agente fuera de banda por línea, con su razón LITERAL: `48% ok ·
           12 de 23 por tools fallando` dice qué mirar; una barra de color
           sólo dice que algo está mal. -->
      <button
        v-for="v in verdict.outOfBand"
        :key="v.agentId"
        type="button"
        class="hv__agent"
        data-testid="verdict-out-of-band"
        :title="`Abrir la página de ${v.agentId}`"
        @click="emit('open', v.agentId)"
      >
        <span class="hv__agent-id">{{ v.agentId }}</span>
        <span class="hv__agent-reason">{{ v.reason }}</span>
        <span class="hv__agent-go" aria-hidden="true">→</span>
      </button>

      <!-- Los sanos son UNA línea plegada con sus tasas: son la parte del día
           que no hay que mirar, y listarlos los pone a competir con el que sí. -->
      <button
        v-if="verdict.healthy.length"
        type="button"
        class="hv__healthy"
        :aria-expanded="healthyOpen"
        data-testid="verdict-healthy"
        @click="healthyOpen = !healthyOpen"
      >
        <span class="hv__healthy-caret" aria-hidden="true">{{ healthyOpen ? '▾' : '▸' }}</span>
        {{ verdict.healthy.length }}
        {{ verdict.healthy.length === 1 ? 'agente' : 'agentes' }}
        {{ verdict.outOfBand.length ? 'más, en banda' : 'en banda' }}
        <span class="hv__healthy-rates">
          {{ verdict.healthy.map((a) => percent(a.successRate)).join(' · ') }}
        </span>
      </button>
      <ul v-if="healthyOpen" class="hv__healthy-list">
        <li v-for="a in verdict.healthy" :key="a.agentId">
          <button type="button" class="hv__healthy-row" @click="emit('open', a.agentId)">
            <span class="hv__agent-id">{{ a.agentId }}</span>
            <span class="hv__agent-reason">{{ percent(a.successRate) }} ok · {{ a.runs }} runs</span>
          </button>
        </li>
      </ul>

      <!-- Pocos runs no es "en banda": es que todavía no se puede decir nada.
           Afirmar que está sano con dos runs es inventar. -->
      <p v-if="verdict.lowSample.length" class="hv__low">
        {{ verdict.lowSample.length }}
        {{ verdict.lowSample.length === 1 ? 'agente todavía sin' : 'agentes todavía sin' }}
        muestra suficiente en esta ventana.
      </p>
    </template>
    <p v-else-if="loading" class="hv__low">Cargando salud…</p>
  </div>
</template>

<style scoped>
.hv {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 0.6rem;
}

.hv__counts { display: flex; gap: 0.4rem; }
.hv__count {
  flex: 1;
  /* Se toca (prende su filtro): --tap-h-sm, que es la medida del chip que
     navega — van tres en fila y el destino es ancho. */
  height: var(--tap-h-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35ch;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  cursor: pointer;
}
.hv__count:hover { border-color: var(--border-hi); }
/* El único en --danger es el único que pide algo. */
.hv__count--waiting { border-color: var(--danger); background: var(--red-bg); color: var(--danger); }
.hv__count--closed { color: var(--fg-dim); }

.hv__totals {
  display: flex;
  align-items: center;
  gap: 0.4ch;
  flex-wrap: wrap;
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  cursor: help;
}
.hv__windows { display: flex; gap: 0.25rem; margin-left: auto; }
.hv__window {
  height: var(--tap-h-sm);
  padding: 0 0.6rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  cursor: pointer;
}
.hv__window--on { background: var(--accent); border-color: var(--accent); color: var(--panel); }

.hv__agent {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0 0.7rem;
  border: none;
  border-left: 3px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--red-bg);
  color: var(--danger);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  text-align: left;
  cursor: pointer;
}
.hv__agent:hover { background: var(--panel-hi); }
.hv__agent-id { flex: 0 0 auto; color: var(--fg); }
.hv__agent-reason {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-micro);
}
.hv__agent-go { flex: 0 0 auto; }

.hv__healthy {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0 0.7rem;
  border: none;
  background: none;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  text-align: left;
  cursor: pointer;
}
.hv__healthy:hover { color: var(--fg); }
.hv__healthy-caret { color: var(--fg-dimmer); }
.hv__healthy-rates { margin-left: auto; color: var(--accent); }

.hv__healthy-list { list-style: none; margin: 0; padding: 0; }
.hv__healthy-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0 1.5rem;
  border: none;
  background: none;
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  text-align: left;
  cursor: pointer;
}
.hv__healthy-row:hover { background: var(--panel-hi); color: var(--fg); }

.hv__error { margin: 0; font-size: var(--fs-body-sm); color: var(--danger); }
.hv__low { margin: 0; font-size: var(--fs-micro); color: var(--fg-dimmer); }
</style>
