<script setup lang="ts">
import type { Rule, RuleActionEntry, WhenCondition } from '@ia-flow/shared'
import { computed, ref, watch } from 'vue'
import ActionsEditor from '@/features/rules/ActionsEditor.vue'
import type { ConditionRow } from '@/ui/condition-rows'
import EventTypePicker from '@/features/rules/EventTypePicker.vue'
import { recurringRuleWarning } from '@/features/rules/rule-templates'
import RuleScopeEditor from '@/features/rules/RuleScopeEditor.vue'
import RuleSentence from '@/features/rules/RuleSentence.vue'

// Editor de una regla. Mismo formato que el editor de agentes —página completa
// con rail de secciones a la izquierda y resumen a la derecha— y no un diálogo
// flotante: la regla tiene cuatro dominios (identidad, disparo, ámbito,
// acciones) que apilados dentro de una caja de 46rem obligaban a scrollear
// dentro del scroll de la página, con los sub-editores (chips, condiciones,
// acciones) creciendo hacia abajo sin que se viera el pie.
//
// El orden de las secciones sigue el orden en que se lee la regla en voz alta:
// cuándo dispara (evento), sobre qué (ámbito + condiciones), y qué hace.

const props = defineProps<{
  rule: Rule | null
  /** Valores con los que arrancar un alta. NO convierte el modal en edición:
   *  `isNew` sigue mirando `rule`, así que el id queda editable — que es lo
   *  único que una plantilla no puede elegir por vos. */
  template?: Partial<Rule> | null
  availableKinds: string[]
  agentIds?: string[]
  repoNames?: string[]
  actionIds?: string[]
  /** Posición de la regla en el listado (1-based) y cuántas hay. Sólo en
   *  edición: un alta todavía no tiene lugar en la lista. */
  position?: number | null
  total?: number
  /** Presente = la regla es de un proyecto; ausente = global. El ámbito no se
   *  edita acá: lo fija la sección desde la que se abrió el modal, igual que en
   *  agents-crud, para que guardar no pueda promover una regla global. */
  projectId?: string | null
  /** La regla se ve pero no se toca: es global y este ámbito es un proyecto
   *  (ver `ScopeGroup`). No alcanza con esconder Guardar —un formulario que
   *  acepta lo que va a descartar es una promesa falsa—, así que el cuerpo va
   *  dentro de un `<fieldset disabled>`: el navegador desactiva TODO control
   *  anidado sin que cada sub-editor tenga que enterarse. El rail queda afuera
   *  del fieldset porque navegar entre secciones se sigue pudiendo. */
  readonly?: boolean
}>()

const emit = defineEmits<{
  (e: 'save', rule: Rule): void
  (e: 'delete', rule: Rule): void
  /** Mover la regla una posición arriba (-1) o abajo (+1). El orden es del
   *  listado, no del formulario: se aplica y se persiste en el acto. */
  (e: 'move', delta: -1 | 1): void
  (e: 'close'): void
}>()

const OPS = [
  { value: '=', label: '= igual' },
  { value: '!=', label: '!= distinto' },
  { value: '$contains', label: 'contiene' },
  { value: '$matches', label: 'matchea regex' },
  { value: '>', label: '> mayor' },
  { value: '>=', label: '>= mayor o igual' },
  { value: '<', label: '< menor' },
  { value: '<=', label: '<= menor o igual' },
  { value: '$null', label: 'es nulo' },
  { value: '$not_null', label: 'no es nulo' },
]

const id = ref('')
const name = ref('')
const description = ref('')
const onTypes = ref('')
const repoName = ref('')
const whenRows = ref<ConditionRow[]>([])
const whenText = ref('')
const schedule = ref('')
const enabled = ref(true)
const exclusive = ref(false)
const actions = ref<RuleActionEntry[]>([])

// `when` viaja como WhenCondition[] pero la fila compartida no conoce `logic`
// (el conector con la anterior). Se preserva por índice al serializar en vez de
// perderse: una regla guardada con un OR tiene que volver siendo la misma.
const logics = ref<Array<'and' | 'or'>>([])

// ─── Rail de secciones — cada entrada resuelve su propio "¿hay algo que
// atender acá?" para el punto de estado. `danger` es lo que impide guardar,
// que es exactamente lo que los tres errores del formulario ya dicen. ──────

type SectionKey = 'definicion' | 'ambito' | 'acciones' | 'avanzado'
type SectionDot = 'good' | 'neutral' | 'danger'

const activeSection = ref<SectionKey>('definicion')

function hydrate(rule: Rule | null) {
  // Una plantilla sólo aplica al alta: en edición, los valores de la regla
  // mandan siempre.
  const seed = (rule ?? props.template ?? null) as Partial<Rule> | null
  id.value = rule?.id ?? ''
  name.value = seed?.name ?? ''
  description.value = seed?.description ?? ''
  onTypes.value = (seed?.on ?? []).join(', ')
  repoName.value = seed?.repoName ?? ''
  whenText.value = seed?.whenText ?? ''
  schedule.value = seed?.schedule ?? ''
  enabled.value = seed?.enabled !== false
  exclusive.value = seed?.exclusive === true
  actions.value = seed?.do ? [...seed.do] : []

  const conds = Array.isArray(seed?.when) ? seed.when : []
  whenRows.value = conds.map((c) => ({ field: c.field, op: c.op, value: c.value ?? '' }))
  logics.value = conds.map((c, i) => (i === 0 ? 'and' : (c.logic ?? 'and')))
}

watch(
  () => [props.rule, props.template],
  () => {
    hydrate(props.rule)
    // Una regla distinta empieza por el principio: dejar el rail donde quedó
    // abre el editor en una sección que no es la que se vino a mirar.
    activeSection.value = 'definicion'
  },
  { immediate: true },
)

const isNew = computed(() => !props.rule)

const idError = computed(() => {
  if (!id.value.trim()) return 'El id es obligatorio'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id.value.trim()))
    return 'Sólo minúsculas, números y guiones'
  return null
})

const parsedOnTypes = computed(() =>
  onTypes.value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
)

const onError = computed(() =>
  parsedOnTypes.value.length ? null : 'Al menos un tipo de evento — si no, la regla nunca dispara',
)

const actionsError = computed(() =>
  actions.value.length ? null : 'Al menos una acción — si no, la regla no hace nada',
)

// Aviso, no error: la regla es válida y se puede guardar. Lo que no puede
// pasar es que nadie la vea antes de que empiece a re-dispararse.
const recurringWarning = computed(() =>
  recurringRuleWarning({
    on: parsedOnTypes.value,
    when: whenRows.value.filter((r) => r.field.trim()),
    whenText: whenText.value,
  }),
)

const canSave = computed(() => !idError.value && !onError.value && !actionsError.value)

const filledConds = computed(() => whenRows.value.filter((r) => r.field.trim()))

const scopeSummary = computed(() => {
  const parts: string[] = []
  if (repoName.value.trim()) parts.push(`repo ${repoName.value.trim()}`)
  if (filledConds.value.length) parts.push(`${filledConds.value.length} condición(es)`)
  if (whenText.value.trim()) parts.push('criterio en texto')
  if (schedule.value.trim()) parts.push(`cron ${schedule.value.trim()}`)
  return parts.length ? parts.join(' · ') : 'sin restricciones'
})

const actionsSummary = computed(() =>
  actions.value.length
    ? actions.value.map((a) => a.action).join(' · ')
    : 'ninguna — la regla no hace nada',
)

const sections = computed<{ key: SectionKey; title: string; summary: string; dot: SectionDot }[]>(
  () => [
    {
      key: 'definicion',
      title: 'Definición',
      summary: parsedOnTypes.value.length
        ? `${id.value.trim() || 'sin id'} · ${parsedOnTypes.value.join(', ')}`
        : id.value.trim() || 'sin id',
      dot: idError.value || onError.value ? 'danger' : 'good',
    },
    {
      key: 'ambito',
      title: 'Sobre qué',
      summary: scopeSummary.value,
      dot:
        filledConds.value.length || repoName.value.trim() || whenText.value.trim()
          ? 'good'
          : 'neutral',
    },
    {
      key: 'acciones',
      title: 'Qué hace',
      summary: actionsSummary.value,
      dot: actionsError.value ? 'danger' : 'good',
    },
    {
      key: 'avanzado',
      title: 'Avanzado',
      summary: [enabled.value ? 'habilitada' : 'deshabilitada', exclusive.value ? 'exclusiva' : null]
        .filter(Boolean)
        .join(' · '),
      dot: enabled.value ? 'neutral' : 'danger',
    },
  ],
)

function serializeWhen(): WhenCondition[] | undefined {
  const when: WhenCondition[] = whenRows.value
    .filter((r) => r.field.trim())
    .map((r, i) => {
      const cond: WhenCondition = { field: r.field.trim(), op: r.op }
      if (r.op !== '$null' && r.op !== '$not_null') cond.value = r.value.trim()
      if (i > 0) cond.logic = logics.value[i] ?? 'and'
      return cond
    })
  return when.length ? when : undefined
}

// ─── Resumen — la MISMA frase que el listado, armada con lo que hay en el
// formulario ahora. Verificar que la regla dice lo que uno cree no debería
// obligar a guardar primero y volver a leerla en la lista. ────────────────

const draft = computed<Rule>(() => ({
  id: id.value.trim() || '—',
  name: name.value.trim() || undefined,
  on: parsedOnTypes.value,
  projectId: props.projectId ?? null,
  repoName: repoName.value.trim() || null,
  when: serializeWhen(),
  whenText: whenText.value.trim() || undefined,
  schedule: schedule.value.trim() || undefined,
  enabled: enabled.value,
  exclusive: exclusive.value,
  do: actions.value,
}))

const checklist = computed(() => [
  { label: idError.value ?? 'ID válido', ok: !idError.value },
  { label: onError.value ?? 'Dispara con un evento', ok: !onError.value },
  { label: actionsError.value ?? 'Hace al menos una cosa', ok: !actionsError.value },
  { label: enabled.value ? 'Habilitada' : 'Deshabilitada — no va a correr', ok: enabled.value },
])

function save() {
  if (!canSave.value) return
  emit('save', {
    ...draft.value,
    id: id.value.trim(),
    description: description.value.trim() || undefined,
  })
}
</script>

<template>
  <div class="overlay">
    <div class="page">

      <div class="page-head">
        <button class="back-btn" aria-label="Cerrar" @click="emit('close')">←</button>
        <h3>{{ isNew ? 'Nueva regla' : `Regla ${rule?.id}` }}</h3>
        <div class="page-head-spacer"></div>
        <!-- Borrar vive acá y no en la fila del listado: se hace una vez, no
             se deshace, y desde el detalle se ve exactamente QUÉ regla se
             está por borrar en vez de un ✕ pegado al gesto de reordenar. -->
        <button
          v-if="!isNew && rule && !readonly"
          type="button"
          class="btn btn--danger"
          @click="emit('delete', rule)"
        >Eliminar</button>
        <button type="button" class="btn" @click="emit('close')">
          {{ readonly ? 'Cerrar' : 'Cancelar' }}
        </button>
        <button
          v-if="!readonly"
          type="button"
          class="btn btn--primary"
          :disabled="!canSave"
          @click="save"
        >Guardar regla</button>
      </div>

      <p v-if="readonly" class="readonly-banner">
        Es una regla <b>global</b>: dispara sobre los eventos de este proyecto, pero se edita en
        <b>General → Pipeline</b>, que es donde se ve a qué otros proyectos afecta el cambio.
      </p>

      <div class="page-shell">

        <!-- ── Rail de secciones — responde "¿qué hay acá?" sin entrar. ── -->
        <nav class="rail">
          <button
            v-for="s in sections"
            :key="s.key"
            type="button"
            class="rail-item"
            :class="{ 'rail-item--active': activeSection === s.key }"
            @click="activeSection = s.key"
          >
            <span class="rail-head">
              <span class="rail-dot" :class="`rail-dot--${s.dot}`"></span>
              <span class="rail-title">{{ s.title }}</span>
            </span>
            <span class="rail-sub">{{ s.summary }}</span>
          </button>
        </nav>

        <!-- ── Panel principal — una sección a la vez. ── -->
        <fieldset class="page-main" :disabled="readonly">

          <section v-show="activeSection === 'definicion'" class="section">
            <label class="field">
              <span class="label">Id</span>
              <input
                v-model="id"
                class="input mono"
                :disabled="!isNew"
                placeholder="pr-abierto-avisa-y-revisa"
              />
              <span v-if="idError" class="field-err">{{ idError }}</span>
              <span v-else class="field-hint">No se puede cambiar después de crear la regla.</span>
            </label>
            <label class="field">
              <span class="label">Nombre</span>
              <input v-model="name" class="input" placeholder="Avisar y revisar al abrir un PR" />
            </label>
            <label class="field">
              <span class="label">Descripción</span>
              <input v-model="description" class="input" placeholder="Opcional" />
            </label>

            <!-- `div` y no `label`: un `<label>` reenvía el click de cualquier
                 descendiente a su PRIMER control, y en un campo de chips ése es
                 la ✕ del primer chip. Elegir del desplegable agregaba el tipo y
                 acto seguido borraba el que ya estaba. -->
            <div class="field">
              <span class="label">Tipos de evento</span>
              <EventTypePicker v-model="onTypes" />
              <span v-if="onError" class="field-err">{{ onError }}</span>
              <span v-else class="field-hint">Separados por coma.</span>
              <span v-if="recurringWarning" class="field-warn">⚠ {{ recurringWarning }}</span>
            </div>
          </section>

          <section v-show="activeSection === 'ambito'" class="section">
            <RuleScopeEditor
              v-model:repo-name="repoName"
              v-model:when-rows="whenRows"
              v-model:when-text="whenText"
              v-model:schedule="schedule"
              v-model:logics="logics"
              :ops="OPS"
              :repo-names="repoNames"
              :project-id="projectId"
            />
          </section>

          <section v-show="activeSection === 'acciones'" class="section">
            <ActionsEditor
              v-model="actions"
              :available-kinds="availableKinds"
              :agent-ids="agentIds"
              :action-ids="actionIds"
            />
            <span v-if="actionsError" class="field-err">{{ actionsError }}</span>
          </section>

          <section v-show="activeSection === 'avanzado'" class="section">
            <div class="field">
              <span class="label">Estado</span>
              <label class="check">
                <input v-model="enabled" type="checkbox" />
                <span>Habilitada</span>
              </label>
              <label class="check">
                <input v-model="exclusive" type="checkbox" />
                <span>Exclusiva</span>
              </label>
              <span class="field-hint">
                Por default disparan <b>todas</b> las reglas que matchean. Exclusiva corta a las de
                menor prioridad — recupera el comportamiento de "la primera y basta".
              </span>
            </div>

            <!-- En el listado el orden se cambia arrastrando, que no existe con
                 los dedos ni con el teclado. Acá está el mismo cambio para
                 todos —y el orden importa: la primera exclusiva que matchea
                 gana—. -->
            <div v-if="!isNew && !readonly && position && total && total > 1" class="field">
              <span class="label">Orden</span>
              <div class="order-row">
                <button
                  type="button"
                  class="btn"
                  aria-label="Subir"
                  :disabled="position === 1"
                  @click="emit('move', -1)"
                >↑</button>
                <button
                  type="button"
                  class="btn"
                  aria-label="Bajar"
                  :disabled="position === total"
                  @click="emit('move', 1)"
                >↓</button>
                <span class="field-hint">{{ position }} de {{ total }}</span>
              </div>
            </div>
          </section>

        </fieldset>

        <!-- ── Resumen en lenguaje llano — verificar de un vistazo que la
             regla dice lo que uno cree, sin reconstruirla campo por campo. ── -->
        <aside class="summary-rail">
          <div class="summary-card">
            <h4>Cómo se lee</h4>
            <RuleSentence :rule="draft" class="summary-sentence" />
            <p class="summary-scope">
              <template v-if="projectId">
                Sólo eventos del proyecto <code>{{ projectId }}</code>.
              </template>
              <template v-else>
                Regla global: ve eventos de cualquier proyecto, y es la única clase que ve un
                evento sin proyecto asignado.
              </template>
            </p>
            <div class="check-list">
              <div
                v-for="c in checklist"
                :key="c.label"
                class="check-item"
                :class="c.ok ? 'check-item--ok' : 'check-item--warn'"
              >
                <span class="check-ico">{{ c.ok ? '✓' : '!' }}</span>
                {{ c.label }}
              </div>
            </div>
          </div>
        </aside>

      </div>

    </div>
  </div>
</template>

<style scoped>
/* No es un overlay fixed — el editor reemplaza la lista dentro del <main> de
   AppShell, así el sidebar queda visible y el formulario tiene el alto de la
   pantalla en vez del de una caja centrada. Mismo layout que
   AgentEditorModal. */
.overlay {
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
}

.page {
  flex: 1;
  min-height: 70vh;
  display: flex;
  flex-direction: column;
}

.page-head {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 0.75rem 1.25rem;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.page-head h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--fg);
  font-family: var(--font-display);
}
.page-head-spacer { flex: 1; }

.back-btn {
  background: none;
  border: none;
  font-size: 1.1rem;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0.25rem;
  line-height: 1;
}
.back-btn:hover { color: var(--fg-mute); }

.readonly-banner {
  margin: 0;
  padding: 0.5rem 1.25rem;
  border-bottom: 1px solid var(--border);
  background: var(--yellow-bg);
  color: var(--warn);
  font-size: 0.8rem;
  line-height: 1.5;
}

.page-shell {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 240px 1fr 300px;
  overflow: hidden;
}

/* ── Rail de secciones ─────────────────────────────────────────────── */
.rail {
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 0.75rem 0.6rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.rail-item {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.55rem 0.6rem;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  cursor: pointer;
  text-align: left;
}
.rail-item:hover { background: var(--panel-alt); }
.rail-item--active { background: var(--panel-alt); border-color: var(--border-hi); }
.rail-head { display: flex; align-items: center; gap: 0.45rem; }
.rail-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.rail-dot--good { background: var(--accent); }
.rail-dot--neutral { background: var(--fg-dim); }
.rail-dot--danger { background: var(--danger); }
.rail-title { font-weight: 600; font-size: 0.85rem; color: var(--fg-mute); }
.rail-item--active .rail-title { color: var(--fg); }
.rail-sub {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--fg-dim);
  padding-left: 0.85rem;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

/* ── Panel principal ────────────────────────────────────────────────── */
/* `fieldset` y no `div`: `disabled` desactiva todo control anidado sin que
   cada sub-editor reciba un prop. Hay que neutralizarle el chrome que trae
   por default —borde, márgenes y un `min-inline-size: auto` que le impide
   encogerse dentro de la grilla—. */
.page-main {
  border: 0;
  margin: 0;
  min-inline-size: 0;
  min-width: 0;
  overflow-y: auto;
  padding: 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}
.page-main:disabled { opacity: 0.85; }
.section { display: flex; flex-direction: column; gap: 1.1rem; }

/* ── Fields ─────────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
.label { font-size: 0.82rem; font-weight: 600; color: var(--fg-mute); }
.field-hint { font-size: 0.73rem; color: var(--fg-dim); line-height: 1.4; }
.field-hint code,
.field-warn code { font-family: var(--font-mono); color: var(--fg-mute); }
.field-warn { font-size: 0.73rem; color: var(--warn); line-height: 1.4; }
.field-err { font-size: 0.73rem; color: var(--danger); line-height: 1.4; }

.input {
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border-hi);
  font-size: 0.875rem;
  color: var(--fg);
  background: var(--panel);
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: var(--accent); }
.input:disabled { background: var(--panel-alt); color: var(--fg-dim); cursor: not-allowed; }
.mono { font-family: var(--font-mono); }

.check {
  display: flex;
  align-items: center;
  gap: 0.45ch;
  font-size: 0.85rem;
  color: var(--fg-mute);
  cursor: pointer;
}
.order-row { display: flex; align-items: center; gap: 0.4rem; }

/* ── Resumen ────────────────────────────────────────────────────────── */
.summary-rail {
  border-left: 1px solid var(--border);
  background: var(--panel);
  padding: 1rem;
  overflow-y: auto;
}
.summary-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.9rem;
}
.summary-card h4 {
  margin: 0 0 0.55rem;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
}
/* La frase del listado se corta en una línea; acá hay lugar y lo que importa
   es leerla entera. */
.summary-sentence {
  flex-wrap: wrap;
  white-space: normal;
}
.summary-scope {
  margin: 0.7rem 0 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--fg-dim);
}
.summary-scope code { font-family: var(--font-mono); color: var(--fg-mute); }
.check-list { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.8rem; }
.check-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--fg-mute);
}
.check-ico {
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.62rem;
  flex-shrink: 0;
}
.check-item--ok .check-ico { background: var(--green-bg); color: var(--accent); }
.check-item--warn .check-ico { background: var(--yellow-bg); color: var(--warn); }

/* ── Mobile ─────────────────────────────────────────────────────────── */
@media (max-width: 900px) {
  /* Tres columnas con dos fijas (240 + 1fr + 300) suman 540px de mínimo: en
     390px el panel del medio —el único donde se edita— quedaba en cero y el
     `overflow: hidden` recortaba el resto. Se apila en una sola columna, y
     cada panel suelta su scroll propio para que sólo scrollee la página. */
  .page-shell {
    grid-template-columns: 1fr;
    overflow: visible;
  }
  .page { min-height: 0; }
  .rail,
  .page-main,
  .summary-rail { overflow: visible; }
  .rail {
    flex-direction: row;
    gap: 0.35rem;
    padding: 0.5rem;
    border-right: none;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .rail-item { flex: 0 0 auto; }
  .rail-sub { display: none; }
  .page-main { padding: 1rem 0.85rem; }
  .summary-rail { border-left: none; border-top: 1px solid var(--border); }
}

@media (max-width: 640px) {
  /* Back + título + Cancelar + Guardar no entran en una línea de 390px, y el
     head es un flex sin `wrap`: los botones se comían el título. El spacer
     —que ya existía para empujarlos a la derecha— pasa a ser el salto de
     línea. */
  .page-head {
    flex-wrap: wrap;
    gap: 0.5rem 0.6rem;
    padding: 0.6rem 0.75rem;
  }
  .page-head h3 {
    flex: 1 1 0;
    min-width: 0;
    font-size: 0.95rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .page-head-spacer { flex: 0 0 100%; height: 0; }
  .page-head .btn { flex: 1 1 0; }
}
</style>
