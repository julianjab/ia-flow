<script setup lang="ts">
import type { EditableTool } from '@ia-flow/shared'
import { computed, onMounted, ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import {
  type BuiltInTool,
  deleteEditableTool,
  fetchEditableTools,
  fetchActionIds,
  saveEditableTool,
} from '@/features/tools/api'
import InlineEdit from '@/ui/InlineEdit.vue'
import { useToastStore } from '@/stores/toast'

// Las tools que ve un agente, y qué se puede tocar de cada una.
//
// Las dos listas están separadas porque lo editable es distinto y esa
// diferencia es la feature, no un detalle: de una built-in sólo se puede
// ajustar la DESCRIPCIÓN —el nombre es la clave que los agentes escriben, el
// schema es contra lo que está compilado el `execute`— mientras que una tool
// definida por config es toda suya.

/** Desde qué proyecto se está mirando. Ausente = General.
 *
 *  NO acota la lista de tools —el nombre de una tool es global y la lista es la
 *  misma en todos lados— sino qué acciones se ofrecen al crear una. */
const props = defineProps<{ projectId?: string | null }>()

const toast = useToastStore()

const defined = ref<Extract<EditableTool, { kind: 'defined' }>[]>([])
const builtIns = ref<BuiltInTool[]>([])
const readOnly = ref(false)
const loadError = ref<string | null>(null)

/** Alta de una tool definida. */
const draft = ref<{ name: string; description: string; actionId: string } | null>(null)

/** Las acciones elegibles en este ámbito: las del proyecto más las globales,
 *  o sólo las globales desde General. */
const actionIds = ref<string[]>([])

async function load() {
  loadError.value = null
  try {
    const r = await fetchEditableTools()
    defined.value = r.editable.filter(
      (t): t is Extract<EditableTool, { kind: 'defined' }> => t.kind === 'defined',
    )
    builtIns.value = r.builtIns
    readOnly.value = r.readOnly
  } catch (e) {
    loadError.value = extractErrorMessage(e)
  }
}

async function loadActions() {
  try {
    actionIds.value = await fetchActionIds(props.projectId)
  } catch {
    actionIds.value = []
  }
}

onMounted(() => {
  void load()
  void loadActions()
})

const overriddenCount = computed(() => builtIns.value.filter((b) => b.overridden).length)

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
      kind === 'override'
        ? { kind: 'override', name, description }
        : { ...(existing as Extract<EditableTool, { kind: 'defined' }>), description },
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
  try {
    await saveEditableTool({
      kind: 'defined',
      name: d.name.trim(),
      description: d.description.trim(),
      actionId: d.actionId,
    })
    toast.success(`Tool '${d.name}' creada`)
    draft.value = null
    await load()
  } catch (err) {
    toast.error(`Error: ${extractErrorMessage(err)}`)
  }
}

async function revert(name: string) {
  try {
    const { note } = await deleteEditableTool(name)
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
    <h2>Tools</h2>
    <p class="section-desc">
      Lo que un agente puede invocar. Una tool <b>definida</b> ejecuta una acción con nombre y es
      toda editable; de una <b>built-in</b> sólo se puede ajustar la descripción — el nombre y el
      schema son contra lo que está escrito su código.
      <template v-if="props.projectId">
        <br />El <b>nombre de una tool es global</b>: esta lista es la misma en todos los
        proyectos. Lo que cambia acá es que podés elegir las acciones de este proyecto.
      </template>
    </p>

    <p v-if="loadError" class="ts-error">✕ {{ loadError }}</p>
    <p v-if="readOnly" class="ts-note">
      Sólo lectura — las tools de este deploy vienen del YAML.
    </p>

    <!-- ─── Definidas ─────────────────────────────────────────────── -->
    <h3 class="ts-group">
      Definidas <span class="ts-count">{{ defined.length }}</span>
      <span class="ts-sp" />
      <button v-if="!readOnly && !draft" type="button" class="ts-btn" @click="draft = { name: '', description: '', actionId: actionIds[0] ?? '' }">
        + tool
      </button>
    </h3>

    <p v-if="!defined.length && !draft" class="ts-empty">
      Ninguna todavía. Una tool definida le da al agente una acción como capacidad invocable.
    </p>

    <div v-for="t in defined" :key="t.name" class="ts-item">
      <div class="ts-head">
        <code class="ts-name">{{ t.name }}</code>
        <span class="ts-action">↗ {{ t.actionId }}</span>
        <span class="ts-sp" />
        <button
          v-if="!readOnly"
          type="button"
          class="ts-icon danger"
          aria-label="Eliminar"
          @click="revert(t.name)"
        >✕</button>
      </div>
      <InlineEdit
        :model-value="t.description"
        :disabled="readOnly"
        placeholder="Sin descripción"
        @save="(v) => saveDescription(t.name, 'defined', v)"
      />
    </div>

    <div v-if="draft" class="ts-form">
      <label class="ts-row">
        <span class="ts-lbl">Nombre</span>
        <input v-model="draft.name" class="ts-field ts-mono" placeholder="deploy_staging" />
        <span class="ts-hint">
          Minúsculas y guión bajo — es el identificador que el modelo escribe. Es global: no
          puede repetir el de otra tool ni el de una built-in.
        </span>
      </label>
      <label class="ts-row">
        <span class="ts-lbl">Descripción</span>
        <input v-model="draft.description" class="ts-field" placeholder="Qué hace, para que el modelo sepa cuándo usarla" />
      </label>
      <label class="ts-row">
        <span class="ts-lbl">Acción</span>
        <select v-if="actionIds.length" v-model="draft.actionId" class="ts-field">
          <option v-for="id in actionIds" :key="id" :value="id">{{ id }}</option>
        </select>
        <input v-else v-model="draft.actionId" class="ts-field ts-mono" placeholder="id de la acción" />
        <span v-if="!actionIds.length" class="ts-hint">
          No hay acciones todavía — creá una en Acciones primero.
        </span>
      </label>
      <div class="ts-form-ops">
        <button type="button" class="ts-btn" @click="draft = null">Cancelar</button>
        <button type="button" class="ts-btn primary" @click="createDefined">Crear</button>
      </div>
    </div>

    <!-- ─── Built-in ──────────────────────────────────────────────── -->
    <h3 class="ts-group">
      Built-in <span class="ts-count">{{ builtIns.length }}</span>
      <span v-if="overriddenCount" class="ts-badge">{{ overriddenCount }} ajustada(s)</span>
    </h3>
    <p class="ts-empty">
      Editar una descripción cambia el prompt que ve <b>todo</b> agente que use esa tool, sin
      necesidad de un deploy. Nada lo verifica: probala.
    </p>

    <div v-for="b in builtIns" :key="b.name" class="ts-item">
      <div class="ts-head">
        <code class="ts-name">{{ b.name }}</code>
        <span v-if="b.overridden" class="ts-badge">ajustada</span>
        <span class="ts-sp" />
        <button
          v-if="!readOnly && b.overridden"
          type="button"
          class="ts-icon"
          aria-label="Revertir"
          @click="revert(b.name)"
        >↺</button>
      </div>
      <InlineEdit
        :model-value="b.description"
        :disabled="readOnly"
        :rows="5"
        @save="(v) => saveDescription(b.name, 'override', v)"
      />
    </div>
  </section>
</template>

<style scoped>
.ts { display: flex; flex-direction: column; gap: 0.25rem; }
.ts-group {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-mute);
  margin: 1rem 0 0.2rem;
}
.ts-count, .ts-badge {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  text-transform: none;
  letter-spacing: 0;
}
.ts-badge {
  border: 1px solid var(--warn);
  border-radius: var(--radius-sm);
  color: var(--warn);
  padding: 0 0.4ch;
  line-height: var(--row-h);
}
.ts-sp { flex: 1; }
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
   después de un nombre de largo variable y cada fila cortaba en otro lugar. */
.ts-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 0.6rem;
  line-height: var(--row-h);
  font-size: var(--fs-body-sm);
  min-height: var(--row-h);
}
.ts-head { display: flex; align-items: center; gap: 0.5rem; }
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

.ts-btn, .ts-icon {
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
.ts-btn:hover, .ts-icon:hover { border-color: var(--accent); }
.ts-icon.danger:hover { border-color: var(--danger); color: var(--danger); }
.ts-btn.primary { border-color: var(--accent); color: var(--accent); }

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
.ts-lbl {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
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