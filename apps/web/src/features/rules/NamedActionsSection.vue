<script setup lang="ts">
import type { NamedAction } from '@ia-flow/shared'
import { computed, onMounted, ref, watch } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import {
  createAction,
  deleteAction,
  fetchActionKinds,
  fetchActions,
  fetchPipeline,
  type RuleScope,
  updateAction,
} from '@/features/rules/api'
import ActionFields from '@/features/rules/ActionFields.vue'
import { actionLabelFor, blankActionFor } from '@/features/rules/actionForms/registry'
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue'
import ConfirmDialog from '@/ui/ConfirmDialog.vue'
import EditableCard from '@/ui/EditableCard.vue'
import ScopeGroup from '@/ui/ScopeGroup.vue'
import { useToastStore } from '@/stores/toast'

// Las acciones con nombre del ámbito.
//
// Van debajo del pipeline y no en una pantalla propia: se leen mirando las
// reglas que las usan, y separarlas obligaría a saltar de pantalla para
// entender un `↗ avisar-deploy` que se acaba de ver.

const props = defineProps<{ scope: RuleScope }>()

/** Los agentes elegibles para una acción de tipo `agent`. Se traen del
 *  pipeline, que ya los publica: pedirlos por separado sería un endpoint más
 *  para el mismo dato. Best-effort — sin ellos el campo cae a texto libre. */
const agentIds = ref<string[]>([])

const toast = useToastStore()

const actions = ref<NamedAction[]>([])
/** Las globales que este proyecto ve por herencia: sus reglas las pueden
 *  referenciar con `↗`, así que esconderlas dejaba media lista sin explicar de
 *  dónde salía el id. Se editan en General. */
const inherited = ref<NamedAction[]>([])
const readOnly = ref(false)

/** Los encabezados por ámbito sólo aparecen cuando hay dos que distinguir. */
const showScopeGroups = computed(() => inherited.value.length > 0)
const loadError = ref<string | null>(null)

/** La confirmación in-app pendiente, si hay. */
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

/** El que se está editando o creando. `null` = ninguno. */
const draft = ref<NamedAction | null>(null)
const isNew = ref(false)
/** El abierto es heredado: se lee entero, no se guarda. */
const isInherited = ref(false)

async function load() {
  loadError.value = null
  try {
    const r = await fetchActions(props.scope)
    actions.value = r.actions
    inherited.value = r.inherited
    readOnly.value = r.readOnly
  } catch (e) {
    loadError.value = extractErrorMessage(e)
  }
}

async function loadAgents() {
  try {
    agentIds.value = (await fetchPipeline(props.scope)).vocabulary.agentIds
    // `ref` no aplica acá: una acción con nombre no puede referenciar a otra
    // (ver `NamedActionBodySchema`), que es lo que hace imposibles los ciclos.
    KINDS.value = (await fetchActionKinds()).filter((k) => k !== 'ref')
  } catch {
    agentIds.value = []
  }
}

onMounted(() => {
  void load()
  void loadAgents()
})
watch(
  () => props.scope,
  () => {
    void load()
    void loadAgents()
  },
  { deep: true },
)

function openNew() {
  isNew.value = true
  isInherited.value = false
  draft.value = { id: '', body: blankActionFor('http') as NamedAction['body'] } as NamedAction
}

function openEdit(a: NamedAction) {
  isNew.value = false
  isInherited.value = false
  // Copia: editar en el sitio dejaría la lista mostrando cambios que todavía
  // no se guardaron, y cancelar no tendría a qué volver.
  draft.value = JSON.parse(JSON.stringify(a)) as NamedAction
}

/** El mismo detalle, en lectura. Se abre igual que el de una propia —una
 *  acción heredada se ejecuta de verdad— y lo único que cambia es que no
 *  ofrece guardar ni borrar. */
function openInherited(a: NamedAction) {
  isNew.value = false
  isInherited.value = true
  draft.value = JSON.parse(JSON.stringify(a)) as NamedAction
}

async function save() {
  const a = draft.value
  if (!a || !a.id.trim()) return
  try {
    if (isNew.value) await createAction(props.scope, a)
    else await updateAction(props.scope, a)
    toast.success(`Acción '${a.id}' guardada`)
    draft.value = null
    await load()
  } catch (e) {
    toast.error(`Error: ${extractErrorMessage(e)}`)
  }
}

/**
 * El 409 con la lista de quién la usa NO se traga: se muestra y se ofrece
 * forzar. Borrar una acción que tres reglas usan las rompe en silencio —siguen
 * matcheando, la acción no pasa— y una tool definida que la ejecute queda
 * inservible, así que quien borra tiene que ver la lista antes de decidir.
 */
async function remove(a: NamedAction, force = false) {
  try {
    await deleteAction(props.scope, a.id, { force })
    toast.success(`Acción '${a.id}' eliminada`)
    await load()
  } catch (e) {
    const used = (e as { response?: { data?: { usedBy?: string[] } } }).response?.data?.usedBy
    if (used?.length && !force) {
      // Diálogo propio y no `confirm()` nativo: los botones del nativo los
      // pinta el SISTEMA en el idioma del dispositivo, así que en un teléfono
      // en inglés este mensaje sale en español con "OK / Cancel" abajo.
      pendingConfirm.value = {
        title: 'Eliminar acción en uso',
        message:
          `La usan ${used.length}: ${used.join(', ')}. ` +
          'Si la borrás, van a fallar en esa acción.',
        confirmLabel: 'Borrar igual',
        onConfirm: () => remove(a, true),
      }
      return
    }
    toast.error(`Error: ${extractErrorMessage(e)}`)
  }
}

/** Borrar la que se está editando. Vive en el editor y no en la fila: es la
 *  única vista donde se ve QUÉ acción se borra —y, si la usan reglas, el 409
 *  las lista antes de forzar. */
function removeDraft() {
  const a = draft.value
  if (!a) return
  draft.value = null
  void remove(a)
}

function patchBody(changes: Record<string, unknown>) {
  if (!draft.value) return
  draft.value = {
    ...draft.value,
    body: { ...draft.value.body, ...changes } as NamedAction['body'],
  }
}

/** Los tipos que ESTE daemon sabe ejecutar. Se piden en vez de hardcodearlos:
 *  la lista a mano ofrecía `tool` —que no tiene handler y explotaba al
 *  guardar— y escondía `script`, que sí lo tiene. */
const KINDS = ref<string[]>([])

const kindOptions = computed<ComboOption[]>(() =>
  KINDS.value.map((value) => ({ value, label: actionLabelFor(value), hint: value })),
)

function changeKind(kind: string) {
  if (!draft.value) return
  // Reemplaza en vez de mergear: los campos de una `http` no significan nada en
  // una `emit`, y arrastrarlos deja basura que el server rechaza sin que se vea.
  // El blanco de cada tipo vive en el registry, junto a su form.
  draft.value = {
    ...draft.value,
    body: blankActionFor(kind) as NamedAction['body'],
  }
}
</script>

<template>
  <section class="settings-section na">
    <div class="section-header">
      <div class="section-head-text">
        <h2>Acciones</h2>
        <p class="section-desc">
          Lo que una regla ejecuta. Definidas una vez y referenciadas desde varias reglas con
          <code>↗</code> — editar una cambia todas las que la usan. Una acción suelta dentro de
          una regla sigue funcionando igual; esto es para las que se repiten.
        </p>
      </div>
      <div class="section-head-actions">
        <span class="na-count">{{ actions.length }}</span>
        <button
          v-if="!readOnly && !draft"
          type="button"
          class="btn btn--primary"
          @click="openNew"
        >
          + acción
        </button>
      </div>
    </div>

    <p v-if="loadError" class="na-error">✕ {{ loadError }}</p>
    <p v-else-if="!actions.length && !draft" class="na-empty">
      <template v-if="inherited.length">
        Este proyecto no define acciones propias. Sus reglas pueden referenciar las
        {{ inherited.length }} globales de abajo.
      </template>
      <template v-else>
        Ninguna todavía. Una acción inline dentro de una regla sigue funcionando igual — esto es
        para las que se repiten.
      </template>
    </p>

    <ScopeGroup
      v-if="showScopeGroups"
      variant="own"
      label="De este proyecto"
      :count="actions.length"
    />

    <!-- Sin ✕ en la fila: borrar vive en el editor, donde se ve QUÉ acción se
         está por borrar y qué reglas la usan. -->
    <EditableCard
      v-for="a in actions"
      :key="a.id"
      :clickable="!readOnly"
      @edit="openEdit(a)"
    >
      <!-- Id arriba, nombre abajo — no lado a lado. El id es un identificador
           y el nombre una descripción: apilados, el id funciona como título de
           su propia fila y la descripción tiene el ancho entero. Al lado, cada
           fila arrancaba la descripción en un punto distinto. -->
      <div class="na-item">
        <div class="na-item-top">
          <code class="na-id">{{ a.id }}</code>
          <span class="na-kind">{{ a.body.action }}</span>
        </div>
        <p v-if="a.name" class="na-name">{{ a.name }}</p>
      </div>
    </EditableCard>

    <!-- Heredadas: se listan enteras y se abren en el mismo detalle, en
         lectura. Una regla de este proyecto las puede referenciar con `↗`, así
         que saber qué hacen es tan necesario como con las propias. -->
    <ScopeGroup
      v-if="inherited.length"
      variant="inherited"
      label="Globales"
      :count="inherited.length"
      edit-hint="General → Acciones"
    >
      <EditableCard
        v-for="a in inherited"
        :key="`inherited-${a.id}`"
        clickable
        muted
        @edit="openInherited(a)"
      >
        <div class="na-item">
          <div class="na-item-top">
            <code class="na-id">{{ a.id }}</code>
            <span class="na-kind">{{ a.body.action }}</span>
          </div>
          <p v-if="a.name" class="na-name">{{ a.name }}</p>
        </div>
      </EditableCard>
    </ScopeGroup>

    <div v-if="draft" class="na-form">
      <p v-if="isInherited" class="na-ro-note">
        Es una acción <b>global</b>: este proyecto la puede referenciar, pero se edita en
        <b>General → Acciones</b>, que es donde se ve a qué otras reglas afecta el cambio.
      </p>
      <fieldset class="na-fields" :disabled="isInherited">
      <label class="na-row">
        <span class="uc-label">Id</span>
        <input
          v-model="draft.id"
          class="na-field na-mono"
          :disabled="!isNew"
          placeholder="avisar-deploy"
        />
        <span v-if="!isNew" class="na-hint">
          El id no se edita: cambiarlo rompería toda regla que la referencia.
        </span>
      </label>

      <label class="na-row">
        <span class="uc-label">Nombre</span>
        <input v-model="draft.name" class="na-field" placeholder="Opcional" />
      </label>

      <!-- `div` y no `label`: un `<label>` reenvía el click de cualquier
           descendiente a su primer control. Y `ComboBox` y no `<select>`: el
           desplegable nativo lo pinta el sistema —fondo blanco sobre una
           consola oscura— y no hay CSS que lo tematice. -->
      <div class="na-row">
        <span class="uc-label">Tipo</span>
        <ComboBox
          :model-value="draft.body.action"
          :options="kindOptions"
          :placeholder="actionLabelFor(draft.body.action)"
          empty-text="Ningún tipo coincide"
          @update:model-value="(v) => changeKind(Array.isArray(v) ? (v[0] ?? '') : v)"
        />
      </div>

      <ActionFields :entry="draft.body" :agent-ids="agentIds" @patch="patchBody" />
      </fieldset>

      <div class="na-form-ops">
        <button
          v-if="!isNew && !isInherited"
          type="button"
          class="btn btn--danger"
          @click="removeDraft"
        >Eliminar</button>
        <span class="na-sp" />
        <button type="button" class="btn" @click="draft = null">
          {{ isInherited ? 'Cerrar' : 'Cancelar' }}
        </button>
        <button
          v-if="!isInherited"
          type="button"
          class="btn btn--primary"
          :disabled="!draft.id.trim()"
          @click="save"
        >
          Guardar
        </button>
      </div>
    </div>

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
/* El encabezado sale de `theme.css` (`.section-header`): esta pantalla tenía su
   propio título en mono/micro, así que "Acciones" se leía como el label de un
   grupo y no como el nombre de la sección, al lado de Pipeline. */
.na { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 1.2rem; }
.na-count { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-dim); }
.na-sp { flex: 1; }

.na-empty, .na-hint {
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  margin: 0;
  line-height: 1.5;
}
.na-error { font-size: var(--fs-body-sm); color: var(--danger); margin: 0; }

/* Sólo el CONTENIDO de la fila: la caja, el hover y el ✕ los pone
   `EditableCard`, que es la misma pieza en todas las listas editables. */
.na-item { display: flex; flex-direction: column; gap: 0.1rem; }
.na-item-top {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  /* Envuelve en vez de desbordar: en un celular un id largo con su tipo al
     lado empuja la página. */
  flex-wrap: wrap;
}
.na-id { font-family: var(--font-mono); color: var(--info); }
.na-kind { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-dim); }
.na-name { margin: 0; color: var(--fg-mute); font-size: var(--fs-micro); }

/* `fieldset` y no `div`: `disabled` desactiva todo control anidado sin que
   `ActionFields` ni `ComboBox` reciban un prop. Hay que neutralizarle el chrome
   por default y el `min-inline-size: auto`, que le impide encogerse en un
   contenedor flex. */
.na-fields {
  border: 0;
  margin: 0;
  padding: 0;
  min-inline-size: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.na-ro-note {
  margin: 0 0 0.2rem;
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  line-height: 1.5;
}

.na-form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: 0.6rem;
  margin-top: 0.3rem;
}
.na-row { display: flex; flex-direction: column; gap: 0.15rem; }
.na-field {
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
}
.na-field:disabled { color: var(--fg-dim); }
.na-mono { font-family: var(--font-mono); }
.na-form-ops { display: flex; gap: 0.4rem; justify-content: flex-end; margin-top: 0.2rem; }

</style>