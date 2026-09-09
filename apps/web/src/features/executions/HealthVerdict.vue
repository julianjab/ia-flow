<script setup lang="ts">
import { computed } from 'vue';
import { type ExecutionStats } from './api';
import { compactTokens, formatUsd, percent, WINDOWS } from './health-format';
import { healthLine } from './verdict';

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
 *
 * Ya no busca sus propias stats: las recibe (`useExecutionHealthStats`, que
 * también alimenta los `quickFilters` de `ListControlsBar`, pegados al
 * filtro más abajo). Un fetch, dos lugares del layout.
 */
const props = defineProps<{
  stats: ExecutionStats | null;
  loading?: boolean;
  error?: string;
  windowDays: number;
}>();

const emit = defineEmits<{
  /** Una línea abre la página del agente. La navegación la hace el padre, que
   *  es quien sabe en qué scope estamos. */
  (e: 'open', agentId: string): void;
  (e: 'update:windowDays', days: number): void;
}>();

/** Una línea, siempre (turno 8). Las reglas viven en `verdict.ts`, puras. */
const line = computed(() => healthLine(props.stats));
const totals = computed(() => props.stats?.totals ?? null);
const activeWindowLabel = computed(
  () => WINDOWS.find((w) => w.days === props.windowDays)?.label ?? `${props.windowDays} d`,
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

      <!-- El costo del período: una línea de 30px, no una banda. El período
           ACTIVO lo dice el texto (`· 7 d ·`) y a la derecha quedan los otros
           dos, que son los únicos que hacen algo al tocarlos. Sin caret: un
           `▸` que no despliega nada promete contenido que no existe. -->
      <p v-if="totals" class="hv__totals" data-testid="verdict-totals" :title="totalsTitle">
        <span class="hv__totals-text">
          <strong>{{ totals.runs }}</strong> runs · {{ activeWindowLabel }} ·
          {{ compactTokens(totals.tokensIn) }} frescos ·
          <strong>{{ formatUsd(totals.costUsd) }}</strong> est.
        </span>
        <span class="hv__windows">
          <button
            v-for="w in WINDOWS.filter((x) => x.days !== windowDays)"
            :key="w.days"
            type="button"
            class="hv__window"
            :title="`Ver los últimos ${w.label}`"
            @click="emit('update:windowDays', w.days)"
          >{{ w.label }}</button>
        </span>
      </p>
    </template>
    <p v-else-if="loading" class="hv__low">Cargando salud…</p>
  </div>
</template>

<style scoped>
.hv {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.4rem;
}

/* ── La línea de salud: una, siempre ──────────────────────────────────────
   Dos líneas de texto adentro de un solo blanco táctil: la tasa arriba y la
   causa abajo, las dos truncadas. Siete filas de agente eran 470px; esto son
   ~50, y envolver la causa las volvería a inflar. */
.hv__line {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  /* Sin `min-height: var(--tap-h)`: es un botón, pero sus dos renglones de
     texto ya lo dejan más alto que 44px — forzar el mínimo sólo agregaba
     aire vacío arriba y abajo del texto. */
  padding: 0.25rem 0.7rem;
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
.hv__line-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.hv__line-head,
.hv__line-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* La causa cede primero: es lo que explica, no lo que alarma. */
.hv__line-detail { font-size: var(--fs-micro); color: var(--fg-mute); }
.hv__line-go { flex: 0 0 auto; }

.hv__totals {
  display: flex;
  align-items: baseline;
  gap: 0.4ch;
  /* Una línea, y si no entra se recorta: envolver convertía el costo del
     período en 92px de la parte superior, que es justo lo que el turno 8
     vino a recuperar. El texto completo está en el `title`. Sin
     `min-height: var(--tap-h-sm)`: la línea en sí no se toca — sólo los
     `.hv__window` de adentro, que ya miden su propio blanco táctil —, así
     que forzar 40px acá era aire que ningún control necesitaba. */
  flex-wrap: nowrap;
  padding: 0.2rem 0.7rem;
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  cursor: help;
}
.hv__totals-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hv__windows { flex: 0 0 auto; display: flex; margin-left: auto; padding-left: 0.5ch; }
/* Texto, no botones con caja: dos chips de 55px empujaban la línea a tres
   renglones en 390px — 92px para decir el costo del período, que es justo lo
   que el turno 8 vino a sacar del tope de la pantalla. */
.hv__window {
  padding: 0;
  border: none;
  background: none;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  text-decoration: underline;
  cursor: pointer;
}
.hv__window:hover { color: var(--accent); }
.hv__window + .hv__window::before {
  content: '·';
  margin: 0 0.5ch;
  color: var(--fg-dimmer);
  text-decoration: none;
  display: inline-block;
}

.hv__error { margin: 0; font-size: var(--fs-body-sm); color: var(--danger); }
.hv__low { margin: 0; font-size: var(--fs-micro); color: var(--fg-dimmer); }
</style>
