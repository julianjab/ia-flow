<script setup lang="ts">
import type { NamedAction } from '@ia-flow/shared'
import { onMounted, ref, watch } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import {
  createAction,
  deleteAction,
  fetchActions,
  type RuleScope,
  updateAction,
} from '@/features/rules/api'
import ActionFields from '@/features/rules/ActionFields.vue'
import { useToastStore } from '@/stores/toast'

// Las acciones con nombre del ámbito.
//
// Van debajo del pipeline y no en una pantalla propia: se leen mirando las
// reglas que las usan, y separarlas obligaría a saltar de pantalla para
// entender un `↗ avisar-deploy` que se acaba de ver.

const props = defineProps<{ scope: RuleScope; agentIds?: string[] }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const toast = useToastStore()

const actions = ref<NamedAction[]>([])
const readOnly = ref(false)
const loadError = ref<string | null>(null)

/** El que se está editando o creando. `null` = ninguno. */
const draft = ref<NamedAction | null>(null)
const isNew = ref(false)

async function load() {
  loadError.value = null
  try {
    const r = await fetchActions(props.scope)
    actions.value = r.actions
    readOnly.value = r.readOnly
  } catch (e) {
    loadError.value = extractErrorMessage(e)
  }
}

onMounted(load)
watch(() => props.scope, load, { deep: true })

function openNew() {
  isNew.value = true
  draft.value = { id: '', body: { action: 'http', method: 'POST', url: '' } } as NamedAction
}

function openEdit(a: NamedAction) {
  isNew.value = false
  // Copia: editar en el sitio dejaría la lista mostrando cambios que todavía
  // no se guardaron, y cancelar no tendría a qué volver.
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
    emit('changed')
  } catch (e) {
    toast.error(`Error: ${extractErrorMessage(e)}`)
  }
}

/**
 * El 409 con la lista de reglas NO se traga: se muestra y se ofrece forzar.
 * Borrar una acción que tres reglas usan las rompe en silencio —siguen
 * matcheando, la acción no pasa— así que quien borra tiene que ver cuáles antes
 * de decidir.
 */
async function remove(a: NamedAction, force = false) {
  try {
    await deleteAction(props.scope, a.id, { force })
    toast.success(`Acción '${a.id}' eliminada`)
    await load()
    emit('changed')
  } catch (e) {
    const used = (e as { response?: { data?: { usedBy?: string[] } } }).response?.data?.usedBy
    if (used?.length && !force) {
      // eslint-disable-next-line no-alert
      const go = window.confirm(
        `La usan ${used.length} regla(s): ${used.join(', ')}.\n\n` +
          'Si la borrás, esas reglas van a fallar en esa acción. ¿Borrar igual?',
      )
      if (go) await remove(a, true)
      return
    }
    toast.error(`Error: ${extractErrorMessage(e)}`)
  }
}

function patchBody(changes: Record<string, unknown>) {
  if (!draft.value) return
  draft.value = {
    ...draft.value,
    body: { ...draft.value.body, ...changes } as NamedAction['body'],
  }
}

const KINDS = ['http', 'emit', 'tool', 'agent'] as const

function changeKind(kind: string) {
  if (!draft.value) return
  // Reemplaza en vez de mergear: los campos de una `http` no significan nada en
  // una `emit`, y arrastrarlos deja basura que el server rechaza sin que se vea.
  const blank: Record<string, unknown> =
    kind === 'http'
      ? { action: 'http', method: 'POST', url: '' }
      : kind === 'emit'
        ? { action: 'emit', type: '' }
        : kind === 'tool'
          ? { action: 'tool', tool: '' }
          : { action: 'agent', agentId: '' }
  draft.value = { ...draft.value, body: blank as NamedAction['body'] }
}
</script>

<template>
  <section class="na">
    <header class="na-head">
      <h3 class="na-title">Acciones con nombre</h3>
      <span class="na-count">{{ actions.length }}</span>
      <span class="na-sp" />
      <button v-if="!readOnly && !draft" type="button" class="na-add" @click="openNew">
        + acción
      </button>
    </header>

    <p class="na-lede">
      Definidas una vez y referenciadas desde varias reglas con
      <code>↗</code>. Editar una cambia todas las que la usan.
    </p>

    <p v-if="loadError" class="na-error">✕ {{ loadError }}</p>
    <p v-else-if="!actions.length && !draft" class="na-empty">
      Ninguna todavía. Una acción inline dentro de una regla sigue funcionando igual — esto es
      para las que se repiten.
    </p>

    <div v-for="a in actions" :key="a.id" class="na-item">
      <code class="na-id">{{ a.id }}</code>
      <span class="na-kind">{{ a.body.action }}</span>
      <span v-if="a.name" class="na-name">{{ a.name }}</span>
      <span class="na-sp" />
      <template v-if="!readOnly">
        <button type="button" class="na-icon" aria-label="Editar" @click="openEdit(a)">✎</button>
        <button type="button" class="na-icon danger" aria-label="Eliminar" @click="remove(a)">
          ✕
        </button>
      </template>
    </div>

    <div v-if="draft" class="na-form">
      <label class="na-row">
        <span class="na-lbl">Id</span>
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
        <span class="na-lbl">Nombre</span>
        <input v-model="draft.name" class="na-field" placeholder="Opcional" />
      </label>

      <label class="na-row">
        <span class="na-lbl">Tipo</span>
        <select class="na-field" :value="draft.body.action" @change="changeKind(($event.target as HTMLSelectElement).value)">
          <option v-for="k in KINDS" :key="k" :value="k">{{ k }}</option>
        </select>
      </label>

      <ActionFields :entry="draft.body" :agent-ids="agentIds" @patch="patchBody" />

      <div class="na-form-ops">
        <button type="button" class="na-btn" @click="draft = null">Cancelar</button>
        <button type="button" class="na-btn primary" :disabled="!draft.id.trim()" @click="save">
          Guardar
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.na { display: flex; flex-direction: column; gap: 0.25rem; margin-top: 1.2rem; }
.na-head { display: flex; align-items: baseline; gap: 0.6rem; }
.na-title {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-mute);
  margin: 0;
}
.na-count { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-dim); }
.na-sp { flex: 1; }
.na-add, .na-icon, .na-btn {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-alt);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  padding: 0 0.5ch;
  cursor: pointer;
}
.na-add:hover, .na-icon:hover, .na-btn:hover { border-color: var(--accent); }
.na-icon.danger:hover { border-color: var(--danger); color: var(--danger); }
.na-btn.primary { border-color: var(--accent); color: var(--accent); }
.na-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.na-lede, .na-empty, .na-hint {
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  margin: 0;
  line-height: 1.5;
}
.na-error { font-size: var(--fs-body-sm); color: var(--danger); margin: 0; }
.na-lede code { font-family: var(--font-mono); color: var(--info); }

.na-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 0.6rem;
  line-height: var(--row-h);
  font-size: var(--fs-body-sm);
}
.na-id { font-family: var(--font-mono); color: var(--info); }
.na-kind { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-dim); }
.na-name { color: var(--fg-mute); font-size: var(--fs-micro); }

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
.na-lbl {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
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
