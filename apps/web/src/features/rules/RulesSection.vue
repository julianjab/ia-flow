<script setup lang="ts">
import type { Pipeline, RunningAgent } from '@ia-flow/shared'
import type { Rule } from '@ia-flow/shared'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import {
  createRule,
  deleteRule,
  fetchActionKinds,
  fetchPipeline,
  fetchRules,
  reorderRules,
  type RuleScope,
  setRuleEnabledInProject,
  updateRule,
} from '@/features/rules/api'
import RuleEditorModal from '@/features/rules/RuleEditorModal.vue'
import { RULE_TEMPLATES, type RuleTemplate } from '@/features/rules/rule-templates'
import RuleSentence from '@/features/rules/RuleSentence.vue'
import ConfirmDialog from '@/ui/ConfirmDialog.vue'
import EditableCard from '@/ui/EditableCard.vue'
import ScopeGroup from '@/ui/ScopeGroup.vue'
import ToggleSwitch from '@/ui/ToggleSwitch.vue'
import { useToastStore } from '@/stores/toast'

// Listado y CRUD de reglas de un ámbito. El ámbito es prop y no estado propio:
// quien monta la sección decide si muestra las globales o las de un proyecto,
// igual que hace la sección de agentes.

const props = defineProps<{
  scope: RuleScope
  agentIds?: string[]
  repoNames?: string[]
}>()

const toast = useToastStore()

const rules = ref<Rule[]>([])
/** Las globales que este proyecto ve por herencia. Disparan sobre sus eventos
 *  igual que las propias —y ANTES, porque el matcher ordena por especificidad—
 *  así que esconderlas mostraba media configuración: un proyecto sin reglas
 *  propias se veía vacío mientras cinco globales trabajaban sobre sus issues. */
const inherited = ref<Rule[]>([])
const readOnly = ref(false)
const actionKinds = ref<string[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)

// Lo que corre encima de estas reglas. Se pide aparte del CRUD y se refresca
// solo: las reglas cambian cuando alguien las edita, el estado cambia todo el
// tiempo. Mezclarlos en un fetch obligaría a recargar el listado entero para
// ver que un run terminó.
const live = ref<Pipeline | null>(null)

// El picker se muestra ANTES del modal y no adentro: elegir la forma de la
// regla y llenar sus campos son dos decisiones distintas, y meterlas en la
// misma pantalla obliga a leer el formulario entero para descubrir que había
// un atajo.
const pickerOpen = ref(false)
const template = ref<Partial<Rule> | null>(null)

// Qué regla está abierta vive en la URL (:detailId — 'new' para alta) y no en
// un ref local, igual que el detalle de un agente: el editor ocupa la página
// entera, así que sin esto el back del navegador se llevaba puesta la pantalla
// en vez de cerrar el detalle, y un detalle no se podía linkear.
const route = useRoute()
const router = useRouter()

const modalOpen = ref(false)
const editing = ref<Rule | null>(null)
/** El detalle abierto es de una regla heredada: se lee entera, no se guarda. */
const editingInherited = ref(false)
const confirmDelete = ref<Rule | null>(null)
/** El primer `load()` ya volvió. Sin esto, una navegación directa a la URL de
 *  un detalle resuelve contra un listado vacío y se lee como "no existe". */
const loaded = ref(false)

const projectId = computed(() => (props.scope.kind === 'project' ? props.scope.projectId : null))

// ─── Globales dadas de baja EN ESTE PROYECTO ────────────────────────────
//
// Vive en `project.settings.disabledRuleIds` y no en la regla: la misma regla
// global sigue corriendo en los otros proyectos (ver
// ProjectSettingsSchema.disabledRuleIds). Por eso es un estado distinto de
// `rule.enabled === false`, que la apaga para todos, y por eso se muestra
// aparte: leer lo mismo en los dos casos dejaría al operador sin saber si
// tocando acá arregla algo o rompe los otros N proyectos.
//
// Llega en el mismo GET que el listado. No sale del store de proyectos aunque
// el dato viva en sus settings: `features/rules` no importa de
// `features/projects` (ver el CLAUDE.md de apps/web), y esta pantalla ya está
// pidiendo la lista a la que el dato pertenece.
const disabledHere = ref<string[]>([])

function isDisabledHere(rule: Rule): boolean {
  return disabledHere.value.includes(rule.id)
}

/**
 * ¿Tiene sentido el interruptor para esta regla?
 *
 * Dos casos donde no, y en los dos se esconde en vez de mostrarse apagado: un
 * control que no puede cambiar nada miente sobre lo que esta pantalla decide.
 *
 *  - Apagada en General (`enabled === false`): no corre en ningún lado, y
 *    prenderla acá no es una decisión de este proyecto.
 *  - Agendada (`schedule`): su tick lo emite el cron con el scope de la REGLA,
 *    y el de una global es vacío — corre una vez para todo el proceso, no una
 *    por proyecto. No hay un "acá" que apagar; el server rechaza el intento
 *    con ese motivo.
 */
function canToggleHere(rule: Rule): boolean {
  return Boolean(projectId.value) && !readOnly.value && rule.enabled !== false && !rule.schedule
}

const togglingId = ref<string | null>(null)

/**
 * Da de baja (o vuelve a dar de alta) una global en este proyecto.
 *
 * Manda el id y la intención, no la lista: `disabledRuleIds` la comparten
 * todas las reglas del proyecto, así que dos pestañas apagando reglas
 * distintas se pisarían si cada una escribiera su copia. La lista que vuelve
 * es la que quedó.
 */
async function toggleInherited(rule: Rule) {
  const pid = projectId.value
  if (!pid) return
  const enabling = isDisabledHere(rule)
  togglingId.value = rule.id
  try {
    disabledHere.value = await setRuleEnabledInProject(rule.id, pid, enabling)
    // El pipeline en vivo lo calcula el server sobre las reglas VISIBLES, así
    // que los huecos y lo que figura corriendo cambian con esto.
    await loadLive()
    toast.success(
      enabling ? `"${rule.id}" vuelve a correr acá` : `"${rule.id}" ya no corre en este proyecto`,
    )
  } catch (e) {
    toast.error(extractErrorMessage(e))
  } finally {
    togglingId.value = null
  }
}

/** Los encabezados por ámbito sólo aparecen cuando hay dos ámbitos que
 *  distinguir. En General —donde las globales SON las propias— serían chrome
 *  que no informa nada. */
const showScopeGroups = computed(() => inherited.value.length > 0)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [list, kinds] = await Promise.all([fetchRules(props.scope), fetchActionKinds()])
    rules.value = list.rules
    inherited.value = list.inherited
    disabledHere.value = list.disabledHere
    readOnly.value = list.readOnly
    actionKinds.value = kinds
  } catch (e) {
    loadError.value = extractErrorMessage(e)
  } finally {
    loading.value = false
    loaded.value = true
  }
}

/** Best-effort: si el pipeline no responde, el CRUD sigue funcionando sin el
 *  overlay. Perder "qué corre" no puede impedir editar una regla. */
async function loadLive() {
  try {
    live.value = await fetchPipeline(props.scope)
  } catch {
    live.value = null
  }
}

// Refresco periódico y no WebSocket: lo que cambia acá —qué corre ahora— se
// mide en decenas de segundos, y un canal nuevo sería infraestructura sin
// problema que resolver.
const LIVE_POLL_MS = 5000
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  void load()
  void loadLive()
  timer = setInterval(loadLive, LIVE_POLL_MS)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
watch(
  () => props.scope,
  () => {
    void load()
    void loadLive()
  },
  { deep: true },
)

/** Runs indexados por la regla que los lanzó. Un run sin regla —o de una regla
 *  fuera de este ámbito— NO se cuelga de ninguna: mostrarlo bajo una
 *  equivocada sería peor que no mostrarlo acá. */
const runsByRule = computed(() => {
  const by = new Map<string, RunningAgent[]>()
  for (const r of live.value?.running ?? []) {
    if (!r.ruleId) continue
    const bucket = by.get(r.ruleId)
    if (bucket) bucket.push(r)
    else by.set(r.ruleId, [r])
  }
  return by
})

// El vocabulario del ámbito gana sobre las props: hasta ahora ninguna vista se
// las pasaba, así que el editor caía a inputs de texto libre para agente y repo
// — sabiendo perfectamente cuáles existen.
const agentOptions = computed(() => live.value?.vocabulary.agentIds ?? props.agentIds ?? [])
const repoOptions = computed(() => live.value?.vocabulary.repos ?? props.repoNames ?? [])
const actionOptions = computed(() => live.value?.vocabulary.actionIds ?? [])

const waits = computed(() => live.value?.waits ?? [])
const gaps = computed(() => live.value?.gaps ?? { unusedAgents: [], statusesWithoutRules: [] })

function runLabel(r: RunningAgent): string {
  return `${r.agentId ?? 'agente'} · ${r.issueNumber ? `#${r.issueNumber}` : r.taskId}`
}

/** Cuánto falta para que venza una espera. Ya vencida = el barrido todavía no
 *  pasó, y decirlo es más útil que mostrar un número negativo. */
function expiresIn(at: string): string {
  const mins = Math.round((new Date(at).getTime() - Date.now()) / 60000)
  if (mins < 0) return 'venciendo'
  return mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`
}

function openNew() {
  editing.value = null
  editingInherited.value = false
  template.value = null
  pickerOpen.value = true
}

function startFrom(t: RuleTemplate) {
  // La plantilla es un valor inicial del alta, no una regla: no tiene id que
  // poner en la URL, así que viaja en el ref y la URL dice `new`.
  template.value = t.build()
  pickerOpen.value = false
  pushRuleId('new')
}

function openEdit(rule: Rule) {
  template.value = null
  pushRuleId(rule.id)
}

/** El mismo detalle, en lectura. Se abre igual que el de una propia —una regla
 *  heredada corre de verdad, así que entenderla es tan necesario como
 *  entender las de acá— y lo único que cambia es que no ofrece guardar: qué
 *  listado la contiene lo resuelve `resolveRuleFromRoute`. */
function openInherited(rule: Rule) {
  openEdit(rule)
}

function pushRuleId(ruleId: string | undefined) {
  if (!route.name) return
  const params = { ...route.params }
  if (ruleId === undefined) delete params.detailId
  else params.detailId = ruleId
  void router.push({ name: route.name, params })
}

/** Traduce la URL a qué se está editando. Que una regla sea propia o heredada
 *  sale de en qué listado aparece y no de un flag que puso quien la abrió: una
 *  navegación directa a la URL no pasó por ningún click. */
function resolveRuleFromRoute() {
  const id = route.params.detailId as string | undefined
  if (!id) {
    modalOpen.value = false
    return
  }
  if (id === 'new') {
    editing.value = null
    editingInherited.value = false
    modalOpen.value = true
    return
  }
  const own = rules.value.find((r) => r.id === id)
  if (own) {
    editing.value = own
    editingInherited.value = false
    modalOpen.value = true
    return
  }
  const global = inherited.value.find((r) => r.id === id)
  if (global) {
    editing.value = global
    editingInherited.value = true
    modalOpen.value = true
    return
  }
  // Sin match: puede ser que el listado todavía no cargó (navegación directa a
  // la URL) y el watcher de abajo reintenta cuando llegue. Recién si YA cargó
  // es un id que no existe —borrado, typo, back tras un delete—: ahí hay que
  // soltar el estado viejo en vez de dejar la URL y el editor mostrando reglas
  // distintas.
  if (!loaded.value) return
  modalOpen.value = false
  editing.value = null
  toast.error(`La regla '${id}' no existe`)
  pushRuleId(undefined)
}

watch(() => route.params.detailId, resolveRuleFromRoute, { immediate: true })
watch([rules, inherited, loaded], resolveRuleFromRoute)

async function handleSave(rule: Rule) {
  try {
    if (editing.value) {
      await updateRule(props.scope, rule)
      toast.success(`Regla '${rule.id}' actualizada`)
    } else {
      await createRule(props.scope, rule)
      toast.success(`Regla '${rule.id}' creada`)
    }
    modalOpen.value = false
    editing.value = null
    pushRuleId(undefined)
    await load()
    void loadLive()
  } catch (e) {
    toast.error(`Error: ${extractErrorMessage(e)}`)
  }
}

/** El detalle pide borrar; la confirmación es de la sección, que es la que
 *  sabe recargar el listado después. */
function askDelete(rule: Rule) {
  modalOpen.value = false
  pushRuleId(undefined)
  confirmDelete.value = rule
}

async function handleDelete(rule: Rule) {
  try {
    await deleteRule(props.scope, rule.id)
    toast.success(`Regla '${rule.id}' eliminada`)
    await load()
    void loadLive()
  } catch (e) {
    toast.error(`Error: ${extractErrorMessage(e)}`)
  } finally {
    confirmDelete.value = null
  }
}

/** Persiste el orden que ya se ve en pantalla. Optimista: reordenar es barato
 *  de revertir (un reload) y esperar el round-trip para ver moverse la fila se
 *  siente roto. */
async function persistOrder(next: Rule[]) {
  const previous = rules.value
  rules.value = next
  try {
    await reorderRules(
      props.scope,
      next.map((r) => r.id),
    )
  } catch (e) {
    rules.value = previous
    toast.error(`Error al reordenar: ${extractErrorMessage(e)}`)
  }
}

function reorder(from: number, to: number) {
  if (from === to || to < 0 || to >= rules.value.length) return
  const next = [...rules.value]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  void persistOrder(next)
}

/** El mismo movimiento que el drag, desde el teclado. Por eso el handle es un
 *  `button` y no un glifo decorativo: arrastrar no existe sin mouse, y el orden
 *  entre reglas decide cuál gana. Antes esto vivía en una sección "Orden" del
 *  detalle, o sea que mover una fila obligaba a abrirla. */
function onHandleKey(i: number, event: KeyboardEvent) {
  if (event.key === 'ArrowUp') reorder(i, i - 1)
  else if (event.key === 'ArrowDown') reorder(i, i + 1)
  else return
  event.preventDefault()
}

// Drag nativo (HTML5), el mismo patrón que ya usan ProviderChoicesEditor y el
// editor de prompts: `dataTransfer` lleva el índice de origen y el drop en la
// fila destino reordena. Sin librería y sin un modo "reordenar" aparte.
const dragIndex = ref<number | null>(null)
const overIndex = ref<number | null>(null)

function onDragStart(i: number, event: DragEvent) {
  dragIndex.value = i
  event.dataTransfer?.setData('text/plain', String(i))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onDragOver(i: number, event: DragEvent) {
  // Sin `preventDefault` el navegador no permite soltar acá.
  event.preventDefault()
  overIndex.value = i
}
function onDragEnd() {
  dragIndex.value = null
  overIndex.value = null
}
function onDrop(to: number) {
  const from = dragIndex.value
  onDragEnd()
  if (from === null || from === to) return
  const next = [...rules.value]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  void persistOrder(next)
}

</script>

<template>
  <section v-if="!modalOpen" class="settings-section rs">
    <div class="section-header">
      <div class="section-head-text">
        <h2>Pipeline</h2>
        <p class="section-desc">
          Qué hace este ámbito y qué está haciendo ahora. Cada regla se lee como una frase:
          cuando pasa un evento, si se cumplen sus condiciones, se ejecutan sus acciones.
          <template v-if="projectId">
            Las de este proyecto se aplican sólo a eventos de <code>{{ projectId }}</code>; las
            globales también disparan acá, y como el matcher ordena por especificidad, las del
            proyecto se evalúan <b>antes</b>.
          </template>
          <template v-else>Éstas son globales: ven eventos de cualquier proyecto.</template>
        </p>
      </div>
      <div class="section-head-actions">
        <!-- El contador y "qué corre ahora" van pegados al botón: contestan la
             misma pregunta que él —qué hay acá y cuánto— y a la izquierda
             empujaban el título distinto en cada pantalla. -->
        <span class="rs-count">{{ rules.length }}</span>
        <span v-if="live?.running.length" class="rs-running">◐ {{ live.running.length }} corriendo</span>
        <button v-if="!readOnly" type="button" class="btn btn--primary" @click="openNew">
          + regla
        </button>
      </div>
    </div>

    <p v-if="readOnly" class="rs-note">
      Sólo lectura — las reglas de este deploy vienen del YAML.
    </p>
    <p v-if="loadError" class="rs-error">{{ loadError }}</p>
    <p v-else-if="loading" class="rs-empty">Cargando…</p>
    <p v-else-if="!rules.length && !pickerOpen" class="rs-empty">
      <template v-if="inherited.length">
        Este proyecto no define reglas propias. Las {{ inherited.length }} globales de abajo
        corren igual sobre sus eventos.
      </template>
      <template v-else>
        Sin reglas todavía. Una regla conecta un evento con lo que tiene que pasar.
      </template>
    </p>

    <div v-if="pickerOpen" class="rs-picker">
      <span class="rs-block-title">empezar desde</span>
      <button
        v-for="t in RULE_TEMPLATES"
        :key="t.key"
        type="button"
        class="rs-tmpl"
        @click="startFrom(t)"
      >
        <span class="rs-tmpl-label">{{ t.label }}</span>
        <span class="rs-tmpl-hint">{{ t.hint }}</span>
      </button>
      <button type="button" class="rs-tmpl-cancel" @click="pickerOpen = false">cancelar</button>
    </div>

    <ScopeGroup
      v-if="showScopeGroups && !pickerOpen"
      variant="own"
      label="De este proyecto"
      :count="rules.length"
    />

    <ul v-if="!pickerOpen && rules.length" class="rs-list">
      <li
        v-for="(rule, i) in rules"
        :key="rule.id"
        class="rs-item"
        :class="{ 'rs-item--over': overIndex === i && dragIndex !== null && dragIndex !== i }"
        :draggable="!readOnly && rules.length > 1"
        @dragstart="onDragStart(i, $event)"
        @dragover="onDragOver(i, $event)"
        @dragend="onDragEnd"
        @drop="onDrop(i)"
      >
        <!-- La fila entera abre el editor: el lápiz al final era un blanco de
             24px en un teléfono y no decía qué editaba. Es el mismo gesto y la
             misma caja que las otras listas editables — ver EditableCard.
             El ✕ vive en el detalle: borrar una regla no es una operación de
             listado (se hace una vez y no se deshace), y tenerlo al lado del
             gesto de arrastrar la ponía a un pixel de distancia. -->
        <!-- `show-edit-button` en false a propósito: `EditableCard` ofrece un
             botón "Editar" cuando la fila NO es clicable, y acá eso pasa
             justamente en el caso en que no se puede editar (un deploy por
             YAML) — abriría el detalle con Guardar, Eliminar y el orden. -->
        <EditableCard
          :clickable="!readOnly"
          :show-edit-button="false"
          :muted="rule.enabled === false"
          @edit="openEdit(rule)"
        >
          <div class="rs-item-top">
            <!-- `button` y no un glifo decorativo: arrastrar no existe sin
                 mouse y el orden entre reglas decide cuál gana, así que las
                 flechas sobre el handle hacen el mismo movimiento. El
                 `click.stop` es porque la fila entera abre el detalle. -->
            <button
              v-if="!readOnly && rules.length > 1"
              type="button"
              class="rs-drag"
              :aria-label="`Reordenar ${rule.id} (flechas para mover)`"
              title="Arrastrar para reordenar"
              @click.stop
              @keydown="onHandleKey(i, $event)"
            >⠿</button>
            <span class="rs-id">{{ rule.id }}</span>
            <span v-if="rule.name" class="rs-name">{{ rule.name }}</span>
            <!-- Los estados de la regla van pegados al borde derecho: son
                 metadata, no su identidad, y a la izquierda empujaban el
                 nombre distinto en cada fila. Contra el borde forman una
                 columna que se barre de un vistazo. -->
            <span class="rs-spacer" />
            <span v-if="rule.enabled === false" class="rs-tag off">deshabilitada</span>
            <span v-if="rule.exclusive" class="rs-tag excl">exclusiva</span>
            <span v-if="rule.repoName" class="rs-tag repo">{{ rule.repoName }}</span>
          </div>
          <!-- La frase arranca en una línea y se parte sólo si no entra: lo
               que cae abajo es la cola (las acciones), nunca el disparador.
               Antes la línea era única y con recorte, y una regla con dos
               condiciones perdía de vista justo su `→ acción` —lo que la
               regla HACE—, que es lo último que se puede esconder. -->
          <div class="rs-item-sentence">
            <RuleSentence :rule="rule" />
          </div>
          <div v-if="runsByRule.get(rule.id)?.length" class="rs-live">
            <span v-for="run in runsByRule.get(rule.id)" :key="run.taskId" class="rs-run">
              ◐ {{ runLabel(run) }}<span v-if="run.isSubAgent" class="rs-tag">sub</span>
            </span>
          </div>
        </EditableCard>
      </li>
    </ul>

    <!-- ─── Heredadas del ámbito global ───────────────────────────────
         Se listan enteras y con sus runs vivos, no como una nota al pie: son
         reglas que ESTÁN corriendo sobre los issues de este proyecto. Lo único
         que no tienen es el gesto de arrastrar (el orden se numera por ámbito,
         así que reordenarlas desde acá no significaría nada) ni el ✕. -->
    <ScopeGroup
      v-if="inherited.length && !pickerOpen"
      variant="inherited"
      label="Globales"
      :count="inherited.length"
      edit-hint="General → Pipeline"
    >
      <ul class="rs-list">
        <li v-for="rule in inherited" :key="`inherited-${rule.id}`" class="rs-item">
          <EditableCard
            clickable
            :show-edit-button="false"
            :muted="rule.enabled === false || isDisabledHere(rule)"
            @edit="openInherited(rule)"
          >
            <div class="rs-item-top">
              <span class="rs-id">{{ rule.id }}</span>
              <span v-if="rule.name" class="rs-name">{{ rule.name }}</span>
              <span class="rs-spacer" />
              <!-- Dos estados distintos, dos tags: "deshabilitada" la apagó
                   General y no corre en ningún lado; "desactivada acá" es esta
                   pantalla y no toca a los demás proyectos. Un solo tag dejaba
                   al operador sin saber cuál de las dos estaba viendo. -->
              <!-- Sólo tags acá: describen la regla y no se tocan. Lo único
                   accionable de esta fila —el interruptor— va a la zona de
                   acciones de la tarjeta, que es donde el resto de las listas
                   pone sus controles. Mezclarlos ponía un tag y un control en
                   la misma tira, y no había forma de saber cuál se podía
                   clickear. -->
              <!-- Apagada en General: no corre en NINGÚN proyecto, y desde acá
                   no se puede prender. Distinto de darla de baja sólo acá. -->
              <span v-if="rule.enabled === false" class="rs-tag off">deshabilitada</span>
              <span v-if="rule.exclusive" class="rs-tag excl">exclusiva</span>
              <span v-if="rule.repoName" class="rs-tag repo">{{ rule.repoName }}</span>
              <!-- Sin este tag, la única fila sin interruptor de la lista no
                   tiene explicación. Corre por cron, una vez para todo el
                   proceso — ver `canToggleHere`. -->
              <span v-if="rule.schedule" class="rs-tag cron">cron {{ rule.schedule }}</span>
            </div>
            <div class="rs-item-sentence">
              <RuleSentence :rule="rule" />
            </div>
            <div v-if="runsByRule.get(rule.id)?.length" class="rs-live">
              <span v-for="run in runsByRule.get(rule.id)" :key="run.taskId" class="rs-run">
                ◐ {{ runLabel(run) }}<span v-if="run.isSubAgent" class="rs-tag">sub</span>
              </span>
            </div>

            <!-- El único gesto que un proyecto tiene sobre una global: no edita
                 la regla (eso es General), decide si corre acá. Por eso convive
                 con `:show-edit-button="false"`.
                 Envuelto en un `<span>` a propósito: `EditableCard` estiliza
                 `:slotted(button)` como su ✕, y eso le pisaría la caja al
                 interruptor. Con el wrapper el botón deja de ser slotted. -->
            <template #actions>
              <span v-if="canToggleHere(rule)" class="rs-here">
                <ToggleSwitch
                  :model-value="!isDisabledHere(rule)"
                  :busy="togglingId === rule.id"
                  :aria-label="`Correr ${rule.id} en este proyecto`"
                  @update:model-value="toggleInherited(rule)"
                />
              </span>
            </template>
          </EditableCard>
        </li>
      </ul>
    </ScopeGroup>

    <!-- Una pausa es una espera con checkpoint: misma fila, distinto glifo. -->
    <div v-if="waits.length" class="rs-block">
      <span class="rs-block-title">esperando</span>
      <div v-for="w in waits" :key="w.id" class="rs-wait">
        <span>{{ w.isPause ? '⏸' : '○' }} {{ w.agentId }} · {{ w.taskId }}</span>
        <span class="rs-tag">{{ w.on.join(', ') }}</span>
        <span class="rs-spacer" />
        <span class="rs-dim">vence en {{ expiresIn(w.expiresAt) }}</span>
      </div>
    </div>

    <!-- Los dos errores de configuración más caros. Nada falla: simplemente no
         pasa nada, y sin esto son invisibles. -->
    <p v-if="gaps.unusedAgents.length" class="rs-gap">
      ✕ <b>{{ gaps.unusedAgents.length }} agente(s) que ninguna regla usa:</b>
      <code>{{ gaps.unusedAgents.join(', ') }}</code> — nunca van a correr.
    </p>
    <p v-if="gaps.statusesWithoutRules.length" class="rs-gap">
      ✕ <b>Sin reglas para:</b> <code>{{ gaps.statusesWithoutRules.join(', ') }}</code> —
      un issue que entre ahí se queda quieto.
    </p>

    <ConfirmDialog
      :open="!!confirmDelete"
      v-if="confirmDelete"
      :danger="true"
      :title="`Eliminar la regla '${confirmDelete.id}'?`"
      message="Los eventos que matcheaba dejan de disparar sus acciones."
      confirm-label="Eliminar"
      @confirm="handleDelete(confirmDelete)"
      @cancel="confirmDelete = null"
    />
  </section>

  <!-- El detalle REEMPLAZA al listado en vez de flotar encima, igual que el de
       agentes: son cuatro dominios de formulario y adentro de una caja
       centrada quedaban dos scrolls anidados con el pie fuera de la vista. -->
  <RuleEditorModal
    v-if="modalOpen"
    :rule="editing"
    :template="template"
    :available-kinds="actionKinds"
    :agent-ids="agentOptions"
    :repo-names="repoOptions"
    :action-ids="actionOptions"
    :project-id="editingInherited ? null : projectId"
    :readonly="editingInherited"
    @save="handleSave"
    @delete="askDelete"
    @close="pushRuleId(undefined)"
  />
</template>

<style scoped>
/* La caja y el encabezado salen de `theme.css` (`.settings-section`,
   `.section-header`): esta pantalla usaba `.panel` + `.panel__header`, que es
   la card densa —la de un drawer o una tabla—, así que Pipeline se veía de otra
   familia que Agentes, Tools o Tareas. */
.rs { display: flex; flex-direction: column; }

.rs-count {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.rs-spacer { flex: 1 1 auto; }

.rs-note,
.rs-empty,
.rs-error {
  margin: 0;
  padding: 0.4rem 0;
  font-size: var(--fs-body-sm);
  color: var(--fg-mute);
  line-height: 1.5;
}
.rs-note { color: var(--warn); }
.rs-empty { color: var(--fg-dimmer); }
.rs-error { color: var(--danger); }

.rs-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin: 0;
  padding: 0;
}
/* El orden entre reglas es parte de lo que la regla ES (la primera exclusiva
   que matchea gana), así que se cambia arrastrando la fila misma y no con un
   par de flechas que hay que apretar N veces para mover una regla al final. */
.rs-item[draggable='true'] { cursor: grab; }
.rs-item[draggable='true']:active { cursor: grabbing; }
.rs-item--over > * { border-color: var(--accent); }
.rs-drag {
  background: none;
  border: none;
  padding: 0;
  font-size: inherit;
  color: var(--fg-dim);
  user-select: none;
  cursor: grab;
}
.rs-drag:hover,
.rs-drag:focus-visible { color: var(--fg); }

/* Sólo el CONTENIDO de la fila: la caja, el hover y el atenuado de una regla
   deshabilitada los pone `EditableCard`. */
.rs-item-top {
  display: flex;
  align-items: center;
  gap: 0.5ch;
  flex-wrap: wrap;
}
.rs-id {
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  color: var(--fg);
}
.rs-tag {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  padding: 0 0.4ch;
  height: var(--row-h);
  line-height: var(--row-h);
  border: 1px solid var(--border);
  color: var(--fg-dim);
  border-radius: var(--radius-sm);
}
.rs-tag.repo { color: var(--info); border-color: var(--info); }
.rs-tag.excl { color: var(--warn); border-color: var(--warn); }
.rs-tag.cron { color: var(--info); border-color: var(--info); }

.rs-here { display: inline-flex; align-items: center; }


.rs-item-sub {
  display: flex;
  align-items: center;
  gap: 0.5ch;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  flex-wrap: wrap;
}
.rs-arrow { color: var(--fg-dimmer); }
.rs-actions { color: var(--fg-mute); }

/* En la primera línea junto al id, no en una tercera: la tarjeta son dos
   líneas —quién es la regla, y qué hace— y todo lo demás está en el detalle. */
.rs-name {
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* Envuelve, alineada a la izquierda: el disparador y la acción entran juntos
   en una línea mientras haya lugar, y cuando no, la acción baja al renglón de
   abajo en vez de quedar recortada contra el borde. Lo que NO se parte es el
   `Cuando … a …`, que `RuleSentence` mantiene en una sola línea. */
.rs-item-sentence {
  min-width: 0;
}
.rs-item-sentence :deep(.rule-sentence) {
  flex-wrap: wrap;
  justify-content: flex-start;
}

.rs-running {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--info);
  white-space: nowrap;
}
.rs-live { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.15rem; }
.rs-run {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  color: var(--info);
  white-space: nowrap;
}
.rs-block { display: flex; flex-direction: column; gap: 0.15rem; margin-top: 0.6rem; }
.rs-block-title {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.rs-wait {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  line-height: var(--row-h);
  color: var(--ai);
}
.rs-dim { color: var(--fg-dim); }
.rs-gap {
  font-size: var(--fs-body-sm);
  color: var(--danger);
  margin: 0.4rem 0 0;
}
.rs-gap code { font-family: var(--font-mono); color: var(--fg-mute); }

.rs-picker { display: flex; flex-direction: column; gap: 0.2rem; }
.rs-tmpl {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--fg);
  padding: 0.35rem 0.6rem;
  cursor: pointer;
  font-family: inherit;
}
.rs-tmpl:hover, .rs-tmpl:focus-visible { border-color: var(--accent); background: var(--panel-hi); }
.rs-tmpl-label { font-size: var(--fs-body-sm); line-height: var(--row-h); }
.rs-tmpl-hint { font-size: var(--fs-micro); color: var(--fg-dim); }
.rs-tmpl-cancel {
  align-self: flex-start;
  margin-top: 0.2rem;
  border: 0;
  background: none;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  cursor: pointer;
}
.rs-tmpl-cancel:hover { color: var(--fg); }
</style>