<script setup lang="ts">
import type { Rule, RuleActionEntry, WhenCondition } from '@ia-flow/shared'
import { computed } from 'vue'

// Una regla es una oración: *cuando pasa X, si se cumple Y, hacé Z*. Escribirla
// así y no como una fila de tabla es lo que permite ENTENDER sin abrir nada —
// el modal queda para editar, que es otra tarea.
//
// El status aparece como un segmento propio y no escondido entre las
// condiciones: desde la migración 059 es una condición más, pero sigue siendo
// la que el operador busca primero ("¿qué corre en Construir?"), así que se
// extrae y se muestra aparte.

const props = defineProps<{ rule: Rule }>()

const conds = computed<WhenCondition[]>(() =>
  Array.isArray(props.rule.when) ? props.rule.when : [],
)

/** El status sobre el que dispara, si la regla lo condiciona. */
const status = computed(() => {
  const c = conds.value.find((c) => c.field === 'status' && (c.op === '=' || c.op === undefined))
  return c ? String(c.value ?? '') : null
})

/** El resto de las condiciones — las que no son el status ya extraído. */
const otherConds = computed(() =>
  conds.value.filter((c) => !(c.field === 'status' && (c.op === '=' || c.op === undefined))),
)

function condLabel(c: WhenCondition): string {
  if (c.op === '$null') return `${c.field} vacío`
  if (c.op === '$not_null') return `${c.field} presente`
  return `${c.field} ${c.op ?? '='} ${c.value ?? ''}`.trim()
}

/** Cómo se lee una acción en la frase. Cada tipo dice lo suyo: un `agent` es
 *  un nombre, un `http` es un destino, un `emit` es un evento nuevo. */
function actionLabel(a: RuleActionEntry): { kind: string; text: string } {
  const e = a as unknown as Record<string, unknown>
  if (a.action === 'agent') return { kind: 'agent', text: String(e.agentId ?? '—') }
  if (a.action === 'http') {
    return { kind: 'http', text: `${String(e.method ?? 'POST')} ${String(e.url ?? '—')}` }
  }
  if (a.action === 'emit') return { kind: 'emit', text: String(e.type ?? '—') }
  // La ref se marca con ↗ y borde punteado: sin eso se lee igual que una
  // acción inline y nadie sabe que al tocarla edita algo definido en otro
  // lado, que además usan otras reglas.
  if (a.action === 'ref') return { kind: 'ref', text: `↗ ${String(e.actionId ?? '—')}` }
  // El schema es una unión cerrada, así que acá TS ya sabe que no queda nada.
  // El fallback existe igual: una acción nueva en el server no puede dejar la
  // frase vacía en un front que todavía no se actualizó.
  const kind = String((a as { action?: string }).action ?? "acción")
  return { kind, text: kind }
}

const actions = computed(() => (props.rule.do ?? []).map(actionLabel))
</script>

<template>
  <span class="rs">
    <span class="rs-kw">Cuando</span>
    <span v-for="t in rule.on" :key="t" class="rs-seg rs-event">{{ t }}</span>

    <template v-if="status">
      <span class="rs-kw">a</span>
      <span class="rs-seg rs-status">{{ status }}</span>
    </template>

    <template v-if="otherConds.length">
      <span class="rs-kw">si</span>
      <span v-for="(c, i) in otherConds" :key="i" class="rs-seg rs-cond">{{ condLabel(c) }}</span>
    </template>

    <template v-for="(a, i) in actions" :key="i">
      <span class="rs-arrow" aria-hidden="true">→</span>
      <span class="rs-seg" :class="`rs-${a.kind}`">{{ a.text }}</span>
    </template>

    <!-- Una regla sin acciones no hace nada. Es un error de configuración
         silencioso, así que se dice en la frase misma. -->
    <template v-if="!actions.length">
      <span class="rs-arrow" aria-hidden="true">→</span>
      <span class="rs-seg rs-empty">sin acciones</span>
    </template>
  </span>
</template>

<style scoped>
.rs {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  line-height: 1.7;
}
.rs-kw {
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
}
.rs-arrow { color: var(--fg-dim); }
/* Una sola caja para todos los tipos (DESIGN_SYSTEM: "lo que varía entre tipos
   es el color del glifo, no la caja"). Es lo que hace que una frase con
   evento + condición + agente se lea como UNA unidad y no como tres widgets
   distintos pegados. */
.rs-seg {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 0.45ch;
  line-height: var(--row-h);
  background: var(--panel-alt);
  white-space: nowrap;
  max-width: 28ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rs-event { color: var(--info); }
.rs-status { color: var(--ai); }
.rs-cond { color: var(--fg-mute); }
.rs-agent { color: var(--accent); }
.rs-ref { color: var(--info); border-style: dashed; }
.rs-empty { color: var(--danger); }
</style>
