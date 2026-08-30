<script setup lang="ts">
import type { EditableTool } from '@ia-flow/shared'
import { computed, onMounted, ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import {
  type BuiltInTool,
  deleteEditableTool,
  fetchEditableTools,
  fetchGlobalActionIds,
  saveEditableTool,
} from '@/features/tools/api'
import { useToastStore } from '@/stores/toast'

// Las tools que ve un agente, y qué se puede tocar de cada una.
//
// Las dos listas están separadas porque lo editable es distinto y esa
// diferencia es la feature, no un detalle: de una built-in sólo se puede
// ajustar la DESCRIPCIÓN —el nombre es la clave que los agentes escriben, el
// schema es contra lo que está compilado el `execute`— mientras que una tool
// definida por config es toda suya.

const toast = useToastStore()

const defined = ref<Extract<EditableTool, { kind: 'defined' }>[]>([])
const builtIns = ref<BuiltInTool[]>([])
const readOnly = ref(false)
const loadError = ref<string | null>(null)

/** La descripción que se está editando, por nombre. Sólo una a la vez. */
const editing = ref<{ name: string; description: string } | null>(null)

/** Alta de una tool definida. */
const draft = ref<{ name: string; description: string; actionId: string } | null>(null)

/** Las acciones elegibles. Se piden al ámbito global: una tool es global, así
 *  que referenciar una acción de proyecto la dejaría rota fuera de él. */
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
    actionIds.value = await fetchGlobalActionIds()
  } catch {
    actionIds.value = []
  }
}

onMounted(() => {
  void load()
  void loadActions()
})

const overriddenCount = computed(() => builtIns.value.filter((b) => b.overridden).length)

async function saveDescription(name: string, kind: 'defined' | 'override') {
  const e = editing.value
  if (!e || !e.description.trim()) return
  try {
    const existing = defined.value.find((d) => d.name === name)
    await saveEditableTool(
      kind === 'override'
        ? { kind: 'override', name, description: e.description }
        : { ...(existing as Extract<EditableTool, { kind: 'defined' }>), description: e.description },
    )
    toast.success(`'${name}' actualizada`)
    editing.value = null
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
      <template v-if="editing?.name !== t.name">
        <code class="ts-name">{{ t.name }}</code>
        <span class="ts-desc">{{ t.description }}</span>
        <span class="ts-sp" />
        <span class="ts-action">↗ {{ t.actionId }}</span>
        <template v-if="!readOnly">
          <button type="button" class="ts-icon" aria-label="Editar" @click="editing = { name: t.name, description: t.description }">✎</button>
          <button type="button" class="ts-icon danger" aria-label="Eliminar" @click="revert(t.name)">✕</button>
        </template>
      </template>
      <template v-else>
        <code class="ts-name">{{ t.name }}</code>
        <input v-model="editing.description" class="ts-field" />
        <button type="button" class="ts-btn" @click="saveDescription(t.name, 'defined')">Guardar</button>
        <button type="button" class="ts-btn" @click="editing = null">Cancelar</button>
      </template>
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
          No hay acciones globales todavía — creá una en Pipeline primero.
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
      <template v-if="editing?.name !== b.name">
        <code class="ts-name">{{ b.name }}</code>
        <span class="ts-desc">{{ b.description }}</span>
        <span class="ts-sp" />
        <span v-if="b.overridden" class="ts-badge">ajustada</span>
        <template v-if="!readOnly">
          <button type="button" class="ts-icon" aria-label="Editar descripción" @click="editing = { name: b.name, description: b.description }">✎</button>
          <button v-if="b.overridden" type="button" class="ts-icon" aria-label="Revertir" @click="revert(b.name)">↺</button>
        </template>
      </template>
      <template v-else>
        <code class="ts-name">{{ b.name }}</code>
        <input v-model="editing.description" class="ts-field" />
        <button type="button" class="ts-btn" @click="saveDescription(b.name, 'override')">Guardar</button>
        <button type="button" class="ts-btn" @click="editing = null">Cancelar</button>
      </template>
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

.ts-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 0.6rem;
  line-height: var(--row-h);
  font-size: var(--fs-body-sm);
  min-height: var(--row-h);
}
.ts-name { font-family: var(--font-mono); color: var(--info); white-space: nowrap; }
.ts-desc { color: var(--fg-mute); font-size: var(--fs-micro); }
.ts-action { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--accent); }

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
</style>
