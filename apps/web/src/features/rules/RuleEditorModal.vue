<script setup lang="ts">
import type { Rule, RuleActionEntry, WhenCondition } from '@ia-flow/shared'
import { computed, ref, watch } from 'vue'
import ActionsEditor from '@/features/rules/ActionsEditor.vue'
import type { ConditionRow } from '@/ui/condition-rows'
import EventTypePicker from '@/features/rules/EventTypePicker.vue'
import { recurringRuleWarning } from '@/features/rules/rule-templates'
import RuleScopeEditor from '@/features/rules/RuleScopeEditor.vue'
import RuleSentence from '@/features/rules/RuleSentence.vue'
import { rowsToWhen, whenToRows } from '@/features/rules/when-serialization'
import CollapsibleSection from '@/ui/CollapsibleSection.vue'
import FormFooter from '@/ui/FormFooter.vue'
import ToggleSwitch from '@/ui/ToggleSwitch.vue'
import { useIsSplit } from '@/composables/useIsMobile'

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
  /** Por qué está en sólo-lectura, para elegir el texto del banner: `'inherited'`
   *  es la global vista desde un proyecto (el caso de arriba); `'yaml'` es un
   *  deploy que carga sus reglas de un `runner.yaml` — ahí no hay "otro lugar
   *  donde editarla", el YAML es la única fuente. */
  readonlyReason?: 'inherited' | 'yaml'
}>()

const emit = defineEmits<{
  (e: 'save', rule: Rule): void
  (e: 'delete', rule: Rule): void
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

// El conector AND/OR va dentro de la fila (`ConditionRow.logic`), no en un
// array paralelo: con el array, `serializeWhen` filtraba las filas sin campo y
// después indexaba los conectores con el índice YA filtrado — una fila a medio
// escribir en el medio guardaba los AND/OR corridos una posición.

// ─── Las franjas del formulario (R19) ─────────────────────────────────────
//
// El mismo orden que el resto de las pantallas de configuración: qué es → qué
// hace → cuándo aplica → crudo. Para una regla, «qué hace» es el evento MÁS
// las acciones —eso es la regla— y el ámbito es lo que la acota. Antes las
// acciones iban después del ámbito, así que el formulario contaba primero las
// excepciones y al final la regla.
//
// Sobre --bp-split el índice es el rail; abajo son las franjas en orden, con
// la última plegada (R24). Cada entrada resuelve su propio "¿hay algo que
// atender acá?" para el punto de estado, y `danger` es lo que impide guardar.

type SectionKey = 'definicion' | 'acciones' | 'ambito' | 'avanzado'
type SectionDot = 'good' | 'neutral' | 'danger'

const activeSection = ref<SectionKey>('definicion')
const { isSplit } = useIsSplit()

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

  whenRows.value = whenToRows(seed?.when)
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

const sections = computed<
  { key: SectionKey; title: string; summary: string; dot: SectionDot; collapsible: boolean }[]
>(() => [
  // Franja 1 · qué es
  {
    key: 'definicion',
    title: 'Definición',
    summary: [id.value.trim() || 'sin id', enabled.value ? null : 'deshabilitada']
      .filter(Boolean)
      .join(' · '),
    dot: idError.value ? 'danger' : enabled.value ? 'good' : 'neutral',
    collapsible: false,
  },
  // Franja 2 · qué hace — el evento y las acciones son la regla.
  {
    key: 'acciones',
    title: 'Qué hace',
    summary: parsedOnTypes.value.length
      ? `${parsedOnTypes.value.join(', ')} → ${actionsSummary.value}`
      : actionsSummary.value,
    dot: onError.value || actionsError.value ? 'danger' : 'good',
    collapsible: false,
  },
  // Franja 3 · cuándo aplica — abierta: una regla existe por su disparo.
  {
    key: 'ambito',
    title: 'Sobre qué',
    summary: scopeSummary.value,
    dot:
      filledConds.value.length || repoName.value.trim() || whenText.value.trim()
        ? 'good'
        : 'neutral',
    collapsible: false,
  },
  // Franja 5 · crudo
  {
    key: 'avanzado',
    title: 'Avanzado',
    summary: [
      exclusive.value ? 'exclusiva' : 'todas las que matchean',
      description.value.trim() ? 'con descripción' : null,
    ]
      .filter(Boolean)
      .join(' · '),
    dot: 'neutral',
    collapsible: true,
  },
])

const sectionByKey = computed(() => new Map(sections.value.map((s) => [s.key, s])))

function bandTag(key: SectionKey) {
  return !isSplit.value && sectionByKey.value.get(key)?.collapsible ? CollapsibleSection : 'section'
}
function bandAttrs(key: SectionKey): Record<string, unknown> {
  if (bandTag(key) === 'section') return { class: 'section' }
  const s = sectionByKey.value.get(key)
  return { title: s?.title, summary: s?.summary }
}
function bandShown(key: SectionKey) {
  return isSplit.value ? activeSection.value === key : true
}

// Lo que falta para guardar, en el pie: bajo --bp-split no hay tercera columna
// donde vive la checklist, y un `Guardar` apagado no dice por qué. Se nombra
// UNA cosa — la primera (R15).
const footerNote = computed(
  () => idError.value ?? onError.value ?? actionsError.value ?? undefined,
)

function serializeWhen(): WhenCondition[] | undefined {
  return rowsToWhen(whenRows.value)
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

      <!-- La cabecera identifica; los botones viven en el pie (R3). El estado
           es un badge acá, como en la fila del listado: se lee sin abrir nada
           y no compite con los campos. Se cambia en Definición, que es el
           único lugar donde se cambia (R17). -->
      <div class="page-head">
        <button class="back-btn" aria-label="Cerrar" @click="emit('close')">←</button>
        <h3>{{ isNew ? 'Nueva regla' : `Regla ${rule?.id}` }}</h3>
        <span class="state-badge" :class="{ 'state-badge--off': !enabled }">
          {{ enabled ? 'activa' : 'deshabilitada' }}
        </span>
      </div>

      <p v-if="readonly && readonlyReason === 'yaml'" class="readonly-banner">
        Sólo lectura — las reglas de este deploy vienen del <b>YAML</b>, no se editan desde acá.
      </p>
      <p v-else-if="readonly" class="readonly-banner">
        Es una regla <b>global</b>: dispara sobre los eventos de este proyecto, pero se edita en
        <b>General → Pipeline</b>, que es donde se ve a qué otros proyectos afecta el cambio.
      </p>

      <div class="page-shell">

        <!-- ── El índice, sobre --bp-split. Abajo de ese ancho no se monta:
             ahí el índice son las franjas en orden y el encabezado de la que
             se pliega (R24). ── -->
        <nav v-if="isSplit" class="rail">
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

        <!-- ── El formulario. Sobre --bp-split, una franja a la vez; abajo,
             todas en orden. `.ff-col` le pone el tope de 46rem (R25). ── -->
        <fieldset class="page-main ff-col" :disabled="readonly">

          <!-- Franja 1 · qué es. Nombre antes que Id: el nombre es lo que se
               lee en la lista y el id se deriva de él; el id iba primero sólo
               porque es el campo obligatorio del schema. -->
          <component
            :is="bandTag('definicion')"
            v-bind="bandAttrs('definicion')"
            v-show="bandShown('definicion')"
          >
            <div class="ff-row">
              <span class="uc-label">Nombre</span>
              <input v-model="name" class="ff-field" placeholder="Avisar y revisar al abrir un PR" />
            </div>
            <div class="ff-row">
              <span class="uc-label">Id</span>
              <input
                v-model="id"
                class="ff-field ff-mono"
                :class="{ 'ff-field--error': idError }"
                :disabled="!isNew"
                placeholder="pr-abierto-avisa-y-revisa"
              />
              <p v-if="idError" class="ff-error">{{ idError }}</p>
              <p v-else class="ff-hint">No se puede cambiar después de crear la regla.</p>
            </div>
            <ToggleSwitch v-model="enabled" label="Habilitada" />
          </component>

          <!-- Franja 2 · qué hace. El evento y las acciones juntos: eso ES la
               regla, y es lo que se vino a escribir. -->
          <component
            :is="bandTag('acciones')"
            v-bind="bandAttrs('acciones')"
            v-show="bandShown('acciones')"
          >
            <h4 v-if="!isSplit" class="band-title">Qué hace</h4>
            <!-- `div` y no `label`: un `<label>` reenvía el click de cualquier
                 descendiente a su PRIMER control, y en un campo de chips ése es
                 la ✕ del primer chip. Elegir del desplegable agregaba el tipo y
                 acto seguido borraba el que ya estaba. -->
            <div class="ff-row">
              <span class="uc-label">Tipos de evento</span>
              <EventTypePicker v-model="onTypes" />
              <p v-if="onError" class="ff-error">{{ onError }}</p>
              <p v-else class="ff-hint">Separados por coma.</p>
              <p v-if="recurringWarning" class="field-warn">⚠ {{ recurringWarning }}</p>
            </div>

            <div class="ff-row">
              <span class="uc-label">Acciones</span>
              <ActionsEditor
                v-model="actions"
                :available-kinds="availableKinds"
                :agent-ids="agentIds"
                :action-ids="actionIds"
              />
              <p v-if="actionsError" class="ff-error">{{ actionsError }}</p>
              <p v-else class="ff-hint">Corren en este orden. Arrastrá para cambiarlo.</p>
            </div>
          </component>

          <!-- Franja 3 · cuándo aplica. Abierta y no plegada: una regla existe
               por su disparo, así que acotarlo no es un detalle opcional. -->
          <component
            :is="bandTag('ambito')"
            v-bind="bandAttrs('ambito')"
            v-show="bandShown('ambito')"
          >
            <h4 v-if="!isSplit" class="band-title">Sobre qué</h4>
            <RuleScopeEditor
              v-model:repo-name="repoName"
              v-model:when-rows="whenRows"
              v-model:when-text="whenText"
              v-model:schedule="schedule"
              :ops="OPS"
              :repo-names="repoNames"
              :project-id="projectId"
            />
          </component>

          <!-- Franja 5 · crudo. Todo con default, así que se pliega. -->
          <component
            :is="bandTag('avanzado')"
            v-bind="bandAttrs('avanzado')"
            v-show="bandShown('avanzado')"
          >
            <div class="ff-row">
              <span class="uc-label">Descripción</span>
              <input v-model="description" class="ff-field" placeholder="— sin descripción —" />
              <p class="ff-hint">Se lee en el listado, debajo del nombre.</p>
            </div>
            <div class="ff-row">
              <span class="uc-label">Prioridad</span>
              <label class="ff-check">
                <input v-model="exclusive" type="checkbox" />
                <span>Exclusiva</span>
              </label>
              <p class="ff-hint">
                Por default disparan <b>todas</b> las reglas que matchean. Exclusiva corta a las de
                menor prioridad — recupera el comportamiento de "la primera y basta".
              </p>
            </div>
          </component>

        </fieldset>

        <!-- ── Resumen en lenguaje llano — verificar de un vistazo que la
             regla dice lo que uno cree, sin reconstruirla campo por campo. ── -->
        <aside v-if="isSplit" class="summary-rail">
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

      <FormFooter
        class="page-foot"
        :note="footerNote"
        note-is-error
        :save-disabled="!canSave"
        save-label="Guardar regla"
        :delete-label="!isNew && rule ? 'Eliminar…' : undefined"
        :readonly="readonly"
        @save="save"
        @cancel="emit('close')"
        @delete="rule && emit('delete', rule)"
      />

    </div>
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>

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
/* El estado se lee acá, como en la fila del listado — no es un campo más
   perdido entre los ocho de «Avanzado». Se CAMBIA en Definición, y en un solo
   lugar (R17). */
.state-badge {
  margin-left: auto;
  flex: 0 0 auto;
  padding: 0 0.75ch;
  line-height: var(--row-h);
  border-radius: var(--radius-sm);
  background: var(--green-bg);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.state-badge--off { background: var(--panel-hi); color: var(--fg-dim); }

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
  overflow-y: auto;
  padding: 1.25rem 1.5rem;
}
/* `.ff-col` trae el flex en columna, el gap y el tope de 46rem; acá sólo se
   centra en el espacio que quede a la derecha del rail. */
.page-main.ff-col { margin-inline: auto; }
.page-main:disabled { opacity: 0.85; }
.section { display: flex; flex-direction: column; gap: 0.9rem; }

/* El título de una franja no plegable, que sólo existe bajo --bp-split: sin el
   rail al costado, tres bloques de campos seguidos no dicen dónde termina uno
   y empieza el otro. Arriba no se dibuja — el rail ya lo dice (R9). */
.band-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--fs-body-sm);
  text-transform: uppercase;
  letter-spacing: var(--tracking-hd);
  color: var(--fg-dim);
}

/* La caja, el label, el hint y el error son del kit (R18). Lo único propio es
   el aviso: NO es un error —la regla es válida y se puede guardar—, así que no
   puede usar la voz del error ni ocupar su ranura. */
.field-warn {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--warn);
  line-height: 1.5;
}
.field-warn code { font-family: var(--font-mono); color: var(--fg-mute); }

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

/* ── Bajo --bp-split: se pierde la segunda columna ──────────────────── */
/* 1100 y no 900 (el valor original): a 900 con el sidebar abierto quedan
   ~670px de contenido, y tres columnas de 240 + 1fr + 300 no entran ahí
   tampoco. Es uno de los tres breakpoints del sistema — ver DESIGN_SYSTEM.md. */
/* ── Pie ────────────────────────────────────────────────────────────────
   Fuera de `.page-shell`, así queda al pie del editor entero y no adentro de
   una de las tres columnas. */
.page-foot {
  flex-shrink: 0;
  padding: 0.5rem 1.25rem;
  border-top: 1px solid var(--border);
  background: var(--panel);
}

@media (max-width: 1100px) {
  /* El rail y el resumen no se montan bajo este ancho (`v-if="isSplit"`), así
     que la grilla de tres columnas queda en una. Antes el rail se volvía una
     tira horizontal de pestañas que se deslizaba: scroll lateral (R2) y un
     índice haciendo de tab (R14). */
  .page-shell {
    grid-template-columns: 1fr;
    overflow: visible;
  }
  .page { min-height: 0; }
  /* El panel traía su propio `overflow-y: auto`: en una sola columna eso es un
     scroll anidado dentro del de la página, y en touch no hay forma de saber
     cuál se está moviendo. */
  .page-main { overflow: visible; padding: 1rem 0.85rem; }
}

@media (max-width: 640px) {
  /* Los botones ya no están en la cabecera —se fueron al pie—, así que el
     título tiene la fila y sólo necesita no desbordarla. */
  .page-head { padding: 0.6rem 0.75rem; }
  .page-head h3 {
    flex: 1 1 0;
    min-width: 0;
    font-size: 0.95rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .page-foot { padding: 0.5rem 0.75rem; }
}
</style>
