<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { type ExecutionStats, fetchExecutionStats } from './api';
import { compactTokens, formatUsd, percent, WINDOWS } from './health-format';
import { type DispositionCount, dispositionCounts, healthLine } from './verdict';

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
 * **Turno 8 · el tope duro.** Una fila por agente fuera de banda asumía dos o
 * tres outliers contra una base sana; con 51% ok los siete agentes califican y
 * la banda se vuelve 470px de rojo que empuja la lista fuera de la pantalla.
 * Ahora la banda es **una línea, siempre**: con uno solo fuera de banda dice
 * quién y por qué, y cuando el fallo es del sistema dice la causa compartida y
 * cuenta los agentes en vez de listarlos. Las reglas viven en `verdict.ts`.
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
/** Una línea, siempre (turno 8). Las reglas viven en `verdict.ts`, puras. */
const line = computed(() => healthLine(stats.value));
const totals = computed(() => stats.value?.totals ?? null);
/** Los totales arrancan plegados: son el costo del período, no lo que pide una
 *  decisión. Plegados miden 30px y llevan adentro el selector de ventana. */
const totalsOpen = ref(false);
const activeWindowLabel = computed(
  () => WINDOWS.find((w) => w.days === windowDays.value)?.label ?? `${windowDays.value} d`,
);

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
      <!-- Una línea, siempre. El `→` lleva a donde se audita: la página del
           agente cuando hay uno señalado, el roster cuando es el sistema. -->
      <button
        v-if="line"
        type="button"
        class="hv__line"
        :class="`hv__line--${line.tone}`"
        data-testid="verdict-line"
        :title="line.agentId ? `Abrir la página de ${line.agentId}` : 'Ver la salud por agente'"
        @click="emit('open', line.agentId ?? '')"
      >
        <span class="hv__line-text">
          <span class="hv__line-head">{{ line.headline }}</span>
          <span v-if="line.detail" class="hv__line-detail">{{ line.detail }}</span>
        </span>
        <span class="hv__line-go" aria-hidden="true">→</span>
      </button>

      <!-- El costo del período, plegado: no pide una decisión, y desplegado son
           los 40px que empujaban la primera fila. Los rangos que NO están
           activos viven adentro — el activo ya lo dice el texto. -->
      <button
        v-if="totals"
        type="button"
        class="hv__totals"
        :aria-expanded="totalsOpen"
        data-testid="verdict-totals"
        :title="totalsTitle"
        @click="totalsOpen = !totalsOpen"
      >
        <span class="hv__totals-caret" aria-hidden="true">{{ totalsOpen ? '▾' : '▸' }}</span>
        <strong>{{ totals.runs }}</strong> runs · {{ activeWindowLabel }} ·
        {{ compactTokens(totals.tokensIn) }} frescos ·
        <strong>{{ formatUsd(totals.costUsd) }}</strong> est.
      </button>
      <div v-if="totalsOpen" class="hv__windows">
        <button
          v-for="w in WINDOWS"
          :key="w.days"
          type="button"
          class="hv__window"
          :class="{ 'hv__window--on': windowDays === w.days }"
          :aria-pressed="windowDays === w.days"
          @click="windowDays = w.days"
        >{{ w.label }}</button>
      </div>
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
  width: 100%;
  /* Plegada mide una fila de grilla y no un blanco táctil: se toca, pero es un
     dato, no una decisión. --tap-h-sm es el compromiso que ya usa el chip. */
  min-height: var(--tap-h-sm);
  padding: 0 0.7rem;
  margin: 0;
  border: none;
  background: none;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  text-align: left;
  cursor: pointer;
}
.hv__totals:hover { color: var(--fg); }
.hv__totals-caret { color: var(--fg-dimmer); }
.hv__windows { display: flex; gap: 0.25rem; padding: 0 0.7rem; }
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

/* ── La línea de salud: una, siempre ──────────────────────────────────────
   Dos líneas de texto adentro de un solo blanco táctil: la tasa arriba y la
   causa abajo. Siete filas de agente eran 470px; esto son 74. */
.hv__line {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0.35rem 0.7rem;
  border: none;
  border-left: 3px solid var(--warn);
  border-radius: var(--radius-sm);
  background: var(--yellow-bg);
  color: var(--warn);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  text-align: left;
  cursor: pointer;
}
.hv__line:hover { background: var(--panel-hi); }
/* Rojo es "algo te espera". Que el server no clasifique los fallos es un
   problema de datos: ámbar. Y sin nadie fuera de banda no hay alarma. */
.hv__line--danger { border-left-color: var(--danger); background: var(--red-bg); color: var(--danger); }
.hv__line--ok {
  border-left-color: var(--border-hi);
  background: transparent;
  color: var(--fg-dim);
}
.hv__line-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }
.hv__line-head { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* La causa cede primero: es lo que explica, no lo que alarma. */
.hv__line-detail {
  font-size: var(--fs-micro);
  color: var(--fg-mute);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hv__line-go { flex: 0 0 auto; }

.hv__error { margin: 0; font-size: var(--fs-body-sm); color: var(--danger); }
.hv__low { margin: 0; font-size: var(--fs-micro); color: var(--fg-dimmer); }
</style>
