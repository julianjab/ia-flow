<script setup lang="ts">
import {
  type ConfigScope,
  type EditableTool,
  type NamedAction,
  type ToolParam,
  inputSchemaToToolParams,
  toolParamsError,
  toolParamsToInputSchema,
} from '@ia-flow/shared'
import { computed, onMounted, ref, watch } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import {
  type BuiltInTool,
  deleteEditableTool,
  fetchActions,
  fetchEditableTools,
  saveEditableTool,
} from '@/features/tools/api'
import ToolParamsEditor from '@/features/tools/ToolParamsEditor.vue'
import ConfirmDialog from '@/ui/ConfirmDialog.vue'
import EditableCard from '@/ui/EditableCard.vue'
import InlineEdit from '@/ui/InlineEdit.vue'
import ScopeGroup from '@/ui/ScopeGroup.vue'
import { useToastStore } from '@/stores/toast'

// Las tools que ve un agente, y qué se puede tocar de cada una.
//
// Tres listas, y las tres divisiones son la feature —no un detalle de armado—
// porque cada una contesta una pregunta distinta sobre qué se puede editar acá:
//
//   Definidas de este ámbito   nacen de la config: son todas suyas.
//   Definidas heredadas        globales vistas desde un proyecto: se leen acá,
//                              se editan en General.
//   Built-in                   viven en el código: sólo su DESCRIPCIÓN se
//                              ajusta, y sólo desde General — `setToolDescription`
//                              pisa el registry del PROCESO, así que un ajuste
//                              por proyecto sería una promesa que el runtime no
//                              puede cumplir.
//
// El NOMBRE de una tool sigue siendo global aunque el ámbito no lo sea (ver
// `ToolNameSchema`): `ProviderInput.tools` viaja como lista de nombres hasta un
// registry único. Por eso dos proyectos no pueden tener dos `deploy_staging`
// distintas, y el server contesta 409 en vez de crear una segunda.

const props = defineProps<{ scope: ConfigScope }>()

type DefinedTool = Extract<EditableTool, { kind: 'defined' }>

const toast = useToastStore()

const defined = ref<DefinedTool[]>([])
const inherited = ref<DefinedTool[]>([])
const builtIns = ref<BuiltInTool[]>([])
const readOnly = ref(false)
const loadError = ref<string | null>(null)

const isProject = computed(() => props.scope.kind === 'project')

/** Qué descripción se está editando en el sitio. Vive acá y no dentro de
 *  `InlineEdit` porque la fila ENTERA la abre: la caja necesita saber si está
 *  abierta para dejar de comportarse como clickeable mientras se edita. */
const openDesc = ref<string | null>(null)

/** Alta de una tool definida. */
const draft = ref<{
  name: string
  description: string
  actionId: string
  params: ToolParam[]
} | null>(null)

/** Las acciones elegibles en este ámbito: las del proyecto más las heredadas,
 *  o sólo las globales desde General. */
const actions = ref<NamedAction[]>([])
const actionIds = computed(() => actions.value.map((a) => a.id))

/** El cuerpo de la acción elegida. Es lo que el editor de parámetros contrasta
 *  contra lo que la tool declara: los `{{event.payload.<campo>}}` que la acción
 *  interpola son exactamente los parámetros que le sirven al modelo. */
function bodyOf(actionId: string): NamedAction['body'] | null {
  return actions.value.find((a) => a.id === actionId)?.body ?? null
}

function onlyDefined(tools: EditableTool[]): DefinedTool[] {
  return tools.filter((t): t is DefinedTool => t.kind === 'defined')
}

async function load() {
  loadError.value = null
  try {
    const r = await fetchEditableTools(props.scope)
    defined.value = onlyDefined(r.editable)
    inherited.value = onlyDefined(r.inherited)
    builtIns.value = r.builtIns
    readOnly.value = r.readOnly
  } catch (e) {
    loadError.value = extractErrorMessage(e)
  }
}

async function loadActions() {
  try {
    actions.value = await fetchActions(props.scope)
  } catch {
    actions.value = []
  }
}

onMounted(() => {
  void load()
  void loadActions()
})
watch(
  () => props.scope,
  () => {
    void load()
    void loadActions()
  },
  { deep: true },
)

const overriddenCount = computed(() => builtIns.value.filter((b) => b.overridden).length)

/** Una built-in sólo se ajusta desde General: el override es del proceso. */
const canEditBuiltIns = computed(() => !readOnly.value && !isProject.value)

/**
 * Guarda la descripción de una tool.
 *
 * De una built-in se guarda un `override` —nunca una `defined`, que la
 * taparía— y de una definida se reescribe la fila entera preservando su acción:
 * la descripción es lo único que este control edita.
 */
async function saveDescription(name: string, kind: 'defined' | 'override', description: string) {
  if (!description.trim()) return
  try {
    const existing = defined.value.find((d) => d.name === name)
    await saveEditableTool(
      props.scope,
      kind === 'override'
        ? { kind: 'override', name, description }
        : { ...(existing as DefinedTool), description },
    )
    toast.success(`'${name}' actualizada`)
    await load()
  } catch (err) {
    toast.error(`Error: ${extractErrorMessage(err)}`)
  }
}

async function createDefined() {
  const d = draft.value
  if (!d?.name.trim() || !d.description.trim() || !d.actionId) return
  // Un parámetro sin nombre o repetido no se guarda a medias: viaja como
  // `properties: { '': ... }` a la API del modelo y le voltea el request entero
  // al primer run que use la tool.
  const invalid = toolParamsError(d.params)
  if (invalid) {
    toast.error(`Parámetros: ${invalid}`)
    return
  }
  try {
    await saveEditableTool(props.scope, {
      kind: 'defined',
      name: d.name.trim(),
      description: d.description.trim(),
      actionId: d.actionId,
      // Sin parámetros no se manda un schema vacío: `toolFromAction` ya cae a
      // `{ type: 'object', properties: {} }`, y guardarlo igual haría ver como
      // configurada una tool que no declaró nada.
      ...(d.params.length ? { inputSchema: toolParamsToInputSchema(d.params) } : {}),
    })
    toast.success(`Tool '${d.name}' creada`)
    draft.value = null
    await load()
  } catch (err) {
    toast.error(`Error: ${extractErrorMessage(err)}`)
  }
}

// ── Parámetros de una tool ya creada ────────────────────────────────────────
//
// Se editan en un panel que se abre, y no en la fila: son varias líneas y
// competirían con la descripción, que se edita en el sitio.

const openParams = ref<string | null>(null)
const paramsDraft = ref<ToolParam[]>([])

/** El `inputSchema` de esta tool dice algo que una lista de parámetros no puede
 *  —se escribió por API con un `array`, un `enum` o un objeto anidado— así que
 *  se avisa en vez de ofrecer un editor que lo destruiría al guardar. */
const paramsUnsupported = ref(false)

function paramCount(t: DefinedTool): number {
  const properties = (t.inputSchema as { properties?: object } | undefined)?.properties
  return properties ? Object.keys(properties).length : 0
}

function toggleParams(t: DefinedTool) {
  if (openParams.value === t.name) {
    openParams.value = null
    return
  }
  const parsed = inputSchemaToToolParams(t.inputSchema)
  paramsUnsupported.value = parsed === null
  paramsDraft.value = parsed ?? []
  openParams.value = t.name
}

async function saveParams(t: DefinedTool) {
  const invalid = toolParamsError(paramsDraft.value)
  if (invalid) {
    toast.error(`Parámetros: ${invalid}`)
    return
  }
  try {
    await saveEditableTool(props.scope, {
      ...t,
      // Sin parámetros se borra el schema en vez de guardar uno vacío: son la
      // misma cosa para el modelo, y una fila con `{}` haría ver como
      // configurado lo que no lo está.
      inputSchema: paramsDraft.value.length
        ? toolParamsToInputSchema(paramsDraft.value)
        : undefined,
    })
    toast.success(`Parámetros de '${t.name}' guardados`)
    openParams.value = null
    await load()
  } catch (err) {
    toast.error(`Error: ${extractErrorMessage(err)}`)
  }
}

/** Confirmación in-app en vez de `confirm()` nativo: los botones del nativo los
 *  pinta el SISTEMA en el idioma del dispositivo, así que en un teléfono en
 *  inglés este mensaje sale en español con "OK / Cancel" abajo. */
const pendingConfirm = ref<{
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void | Promise<void>
} | null>(null)

async function runConfirm() {
  const c = pendingConfirm.value
  if (!c) return
  pendingConfirm.value = null
  await c.onConfirm()
}

/**
 * Borrar una tool definida.
 *
 * Es el único borrado que quedó en la fila —una tool se edita en el sitio, no
 * tiene detalle donde poner el botón— así que la confirmación es lo que cumple
 * el mismo papel: nombrar QUÉ se está por borrar antes de hacerlo.
 */
function askRemoveDefined(name: string) {
  pendingConfirm.value = {
    title: 'Eliminar tool',
    message: `¿Eliminar la tool '${name}'? Los agentes que la declaren se quedan sin ella.`,
    confirmLabel: 'Eliminar',
    onConfirm: () => revert(name),
  }
}

async function revert(name: string) {
  try {
    const { note } = await deleteEditableTool(props.scope, name)
    // El server avisa que la original vuelve al reiniciar: vive en el código y
    // el registry del proceso ya la tiene pisada. Se dice, no se disimula.
    toast.success(note ? `Override quitada. ${note}` : `'${name}' eliminada`)
    await load()
  } catch (err) {
    toast.error(`Error: ${extractErrorMessage(err)}`)
  }
}
</script>

<template>
  <section class="settings-section ts">
    <!-- Mismo encabezado que Acciones, Agentes y Pipeline: el título y la
         descripción a la izquierda, el contador y la acción primaria a la
         derecha en la MISMA fila. El `+ tool` vivía suelto abajo del primer
         grupo y con estilo propio, así que la única acción de la pantalla
         aparecía en un lugar distinto que en las otras listas. -->
    <div class="section-header">
      <div class="section-head-text">
        <h2>Tools</h2>
        <p class="section-desc">
          Lo que un agente puede invocar. Una tool <b>definida</b> ejecuta una acción con nombre y
          es toda editable; de una <b>built-in</b> sólo se puede ajustar la descripción — el
          nombre y el schema son contra lo que está escrito su código.
          <template v-if="isProject">
            <br />Este proyecto define las suyas y <b>hereda las globales</b>. El
            <b>nombre de una tool es único en todo el daemon</b>: el agente lo escribe tal cual y
            el daemon lo resuelve contra un registry único, así que dos proyectos no pueden tener
            dos tools distintas con el mismo nombre.
          </template>
        </p>
      </div>
      <div class="section-head-actions">
        <span class="ts-count">{{ defined.length }}</span>
        <button
          v-if="!readOnly && !draft"
          type="button"
          class="btn btn--primary"
          @click="draft = { name: '', description: '', actionId: actionIds[0] ?? '', params: [] }"
        >
          + tool
        </button>
      </div>
    </div>

    <p v-if="loadError" class="ts-error">✕ {{ loadError }}</p>
    <p v-if="readOnly" class="ts-note">
      Sólo lectura — las tools de este deploy vienen del YAML.
    </p>

    <!-- ─── Definidas de este ámbito ──────────────────────────────── -->
    <ScopeGroup
      variant="own"
      :label="isProject ? 'Definidas por este proyecto' : 'Definidas'"
      :count="defined.length"
    >
      <p v-if="!defined.length && !draft" class="ts-empty">
        Ninguna todavía. Una tool definida le da al agente una acción como capacidad invocable.
      </p>

      <!-- La fila ENTERA abre la edición, igual que en Acciones, Pipeline y
           Agentes: antes el único blanco era el texto de la descripción, así
           que clickear el nombre de la tool —o el espacio en blanco de la
           fila— no hacía nada. Mientras se edita ALGO deja de ser clickeable:
           un click dentro del textarea de la descripción la volvería a
           "abrir", y uno dentro de un campo de parámetros abriría además la
           descripción y le robaría el foco al campo recién clickeado. -->
      <EditableCard
        v-for="t in defined"
        :key="t.name"
        class="ts-item"
        :clickable="!readOnly && openDesc !== t.name && openParams !== t.name"
        :deletable="!readOnly"
        :show-edit-button="false"
        delete-label="Eliminar tool"
        @edit="openDesc = t.name"
        @delete="askRemoveDefined(t.name)"
      >
        <div class="ts-head">
          <code class="ts-name">{{ t.name }}</code>
          <span class="ts-action">↗ {{ t.actionId }}</span>
        </div>
        <InlineEdit
          :model-value="t.description"
          :open="openDesc === t.name"
          :disabled="readOnly"
          placeholder="Sin descripción"
          @update:open="(v) => (openDesc = v ? t.name : null)"
          @save="(v) => saveDescription(t.name, 'defined', v)"
        />

        <!-- `.stop`: sin esto el click sube a la fila y abre además la
             descripción, que no es lo que se pidió al tocar el disclosure. -->
        <button type="button" class="ts-btn ts-toggle" @click.stop="toggleParams(t)">
          {{ openParams === t.name ? '▾' : '▸' }} parámetros
          <span class="ts-count">{{ paramCount(t) }}</span>
        </button>

        <template v-if="openParams === t.name">
          <p v-if="paramsUnsupported" class="ts-note">
            Su schema se escribió por API y usa formas que este editor no representa (un
            <code>array</code>, un <code>enum</code>, un objeto anidado). Se sigue editando por
            <code>PUT /api/tools-crud/{{ t.name }}</code> — acá se rompería al guardar.
          </p>
          <template v-else>
            <ToolParamsEditor
              v-model="paramsDraft"
              :action-body="bodyOf(t.actionId)"
              :disabled="readOnly"
            />
            <div v-if="!readOnly" class="ts-form-ops" @click.stop>
              <button type="button" class="btn" @click="openParams = null">Cancelar</button>
              <button type="button" class="btn btn--primary" @click="saveParams(t)">Guardar</button>
            </div>
          </template>
        </template>
      </EditableCard>

      <div v-if="draft" class="ts-form">
        <label class="ts-row">
          <span class="uc-label">Nombre</span>
          <input v-model="draft.name" class="ts-field ts-mono" placeholder="deploy_staging" />
          <span class="ts-hint">
            Minúsculas y guión bajo — es el identificador que el modelo escribe. Es único en todo
            el daemon: no puede repetir el de otra tool (de este ámbito o de otro) ni el de una
            built-in.
          </span>
        </label>
        <label class="ts-row">
          <span class="uc-label">Descripción</span>
          <input v-model="draft.description" class="ts-field" placeholder="Qué hace, para que el modelo sepa cuándo usarla" />
        </label>
        <label class="ts-row">
          <span class="uc-label">Acción</span>
          <select v-if="actionIds.length" v-model="draft.actionId" class="ts-field">
            <option v-for="id in actionIds" :key="id" :value="id">{{ id }}</option>
          </select>
          <input v-else v-model="draft.actionId" class="ts-field ts-mono" placeholder="id de la acción" />
          <span v-if="!actionIds.length" class="ts-hint">
            No hay acciones todavía — creá una en Acciones primero.
          </span>
        </label>
        <div class="ts-row">
          <ToolParamsEditor v-model="draft.params" :action-body="bodyOf(draft.actionId)" />
        </div>
        <div class="ts-form-ops">
          <button type="button" class="btn" @click="draft = null">Cancelar</button>
          <button type="button" class="btn btn--primary" @click="createDefined">Crear</button>
        </div>
      </div>
    </ScopeGroup>

    <!-- ─── Definidas heredadas ───────────────────────────────────── -->
    <ScopeGroup
      v-if="isProject && inherited.length"
      variant="inherited"
      label="Definidas globales"
      :count="inherited.length"
      edit-hint="General → Tools"
    >
      <!-- Sin ✕ ni InlineEdit: se lee la descripción entera, no se toca. Un
           control deshabilitado ofrecería el gesto para negarlo después. -->
      <EditableCard v-for="t in inherited" :key="t.name" class="ts-item" muted>
        <div class="ts-head">
          <code class="ts-name">{{ t.name }}</code>
          <span class="ts-action">↗ {{ t.actionId }}</span>
        </div>
        <p class="ts-ro-desc">{{ t.description }}</p>
      </EditableCard>
    </ScopeGroup>

    <!-- ─── Built-in ──────────────────────────────────────────────── -->
    <ScopeGroup
      :variant="isProject ? 'inherited' : 'own'"
      label="Built-in"
      :count="builtIns.length"
      :edit-hint="isProject ? 'General → Tools' : undefined"
    >
      <p v-if="overriddenCount" class="ts-note">{{ overriddenCount }} con la descripción ajustada.</p>
      <p class="ts-empty">
        <template v-if="canEditBuiltIns">
          Editar una descripción cambia el prompt que ve <b>todo</b> agente que use esa tool, sin
          necesidad de un deploy. Nada lo verifica: probala.
        </template>
        <template v-else-if="isProject">
          Su descripción la comparte todo el daemon —el ajuste pisa el registry del proceso, no el
          de un proyecto—, así que se edita en General.
        </template>
      </p>

      <!-- Una built-in no se borra: su código vive en el repo. Lo único que se
           quita es el override, así que va un ↺ en el slot de acciones en vez
           del ✕. -->
      <EditableCard
        v-for="b in builtIns"
        :key="b.name"
        class="ts-item"
        :clickable="canEditBuiltIns && openDesc !== b.name"
        :deletable="false"
        :show-edit-button="false"
        :muted="!canEditBuiltIns"
        @edit="openDesc = b.name"
      >
        <div class="ts-head">
          <code class="ts-name">{{ b.name }}</code>
          <span v-if="b.overridden" class="ts-badge">ajustada</span>
        </div>
        <InlineEdit
          v-if="canEditBuiltIns"
          :model-value="b.description"
          :open="openDesc === b.name"
          :rows="5"
          @update:open="(v) => (openDesc = v ? b.name : null)"
          @save="(v) => saveDescription(b.name, 'override', v)"
        />
        <p v-else class="ts-ro-desc">{{ b.description }}</p>

        <template #actions>
          <button
            v-if="canEditBuiltIns && b.overridden"
            type="button"
            aria-label="Revertir"
            title="Revertir al texto original"
            @click="revert(b.name)"
          >↺</button>
        </template>
      </EditableCard>
    </ScopeGroup>

    <ConfirmDialog
      :open="!!pendingConfirm"
      :title="pendingConfirm?.title"
      :message="pendingConfirm?.message ?? ''"
      :confirm-label="pendingConfirm?.confirmLabel"
      danger
      @confirm="runConfirm"
      @cancel="pendingConfirm = null"
    />
  </section>
</template>

<style scoped>
.ts { display: flex; flex-direction: column; gap: 0.25rem; }
/* El encabezado de la sección lo pone `theme.css` y el de cada grupo
   `ScopeGroup` — la misma pieza que en las otras cuatro pantallas que se
   configuran en dos niveles. Acá sólo queda el contador, que es el mismo trato
   para el de la sección y el de los parámetros de una tool. */
.ts-count { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-dim); }

.ts-badge {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  border: 1px solid var(--warn);
  border-radius: var(--radius-sm);
  color: var(--warn);
  padding: 0 0.4ch;
  line-height: var(--row-h);
  text-transform: none;
  letter-spacing: 0;
}

/* La descripción de una tool que no se edita acá. Mismo tamaño que el
   `InlineEdit` que ocupa su lugar en las editables, para que la fila no cambie
   de alto entre grupos. */
.ts-ro-desc {
  margin: 0;
  color: var(--fg-mute);
  font-size: var(--fs-body-sm);
  line-height: 1.5;
}
.ts-error { color: var(--danger); font-size: var(--fs-body-sm); margin: 0; }
.ts-note, .ts-empty, .ts-hint {
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  margin: 0;
  line-height: 1.5;
}

/* Nombre arriba, descripción abajo — no lado a lado.
   La descripción es un párrafo y el nombre un identificador: apilados, el
   nombre funciona como título de su propia fila y la descripción tiene el ancho
   entero para truncar en un punto útil. Al lado, la descripción arrancaba
   después de un nombre de largo variable y cada fila cortaba en otro lugar.

   La caja y el borde los pone `EditableCard`. */
.ts-item :deep(.editable-card__body) {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.ts-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.ts-name {
  font-family: var(--font-mono);
  color: var(--info);
  white-space: nowrap;
  line-height: var(--row-h);
}

.ts-action {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  color: var(--accent);
  white-space: nowrap;
}

/* La caja compacta de un control DENTRO de una fila —hoy sólo el disclosure
   `▸ parámetros`—. No es un `.btn`: los pies de formulario usan los del
   sistema, éste vive en la fila y mide `--row-h` como el ✕ de `EditableCard`. */
.ts-btn {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-alt);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  padding: 0 0.5ch;
  cursor: pointer;
  white-space: nowrap;
}
.ts-btn:hover { border-color: var(--accent); }

.ts-form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: 0.6rem;
  margin-top: 0.3rem;
}
.ts-row { display: flex; flex-direction: column; gap: 0.15rem; }
.ts-field {
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-alt);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  width: 100%;
  box-sizing: border-box;
  flex: 1;
}
.ts-mono { font-family: var(--font-mono); }
/* El toggle de parámetros es una fila más de la tarjeta, no un botón de acción:
   alineado a la izquierda y sin ocupar el ancho entero. */
.ts-toggle { align-self: flex-start; }
.ts-form-ops { display: flex; gap: 0.4rem; justify-content: flex-end; }

@media (max-width: 640px) {
  /* Lo que se EDITA toma la fila entera. Al lado del nombre el textarea queda
     en ~269px de 390, y una descripcion es un parrafo: leerla mientras se
     escribe es justamente para lo que se abre el editor.
     
     `.ts-item` ya envuelve, asi que un `flex-basis: 100%` manda al editor a su
     propia linea y deja el nombre arriba como titulo. */
  .ts-item .ie--open { flex: 1 1 100%; }
  .ts-item .ts-field { flex: 1 1 100%; }
  /* El alta comparte el mismo criterio. */
  .ts-form .ts-field { flex: 1 1 100%; }
}
</style>