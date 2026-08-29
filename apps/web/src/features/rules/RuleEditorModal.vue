<script setup lang="ts">
import type { Rule, RuleActionEntry, WhenCondition } from '@ia-flow/shared'
import { computed, ref, watch } from 'vue'
import ActionsEditor from '@/features/rules/ActionsEditor.vue'
import type { ConditionRow } from '@/ui/condition-rows'
import ConditionRowsEditor from '@/ui/ConditionRowsEditor.vue'

// Editor de una regla. Las cuatro secciones siguen el orden en que se lee la
// regla en voz alta: cuándo dispara (evento), sobre qué (ámbito + condiciones),
// y qué hace (acciones).

const props = defineProps<{
  rule: Rule | null
  availableKinds: string[]
  agentIds?: string[]
  repoNames?: string[]
  /** Presente = la regla es de un proyecto; ausente = global. El ámbito no se
   *  edita acá: lo fija la sección desde la que se abrió el modal, igual que en
   *  agents-crud, para que guardar no pueda promover una regla global. */
  projectId?: string | null
}>()

const emit = defineEmits<{
  (e: 'save', rule: Rule): void
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
const enabled = ref(true)
const exclusive = ref(false)
const actions = ref<RuleActionEntry[]>([])

// `when` viaja como WhenCondition[] pero la fila compartida no conoce `logic`
// (el conector con la anterior). Se preserva por índice al serializar en vez de
// perderse: una regla guardada con un OR tiene que volver siendo la misma.
const logics = ref<Array<'and' | 'or'>>([])

function hydrate(rule: Rule | null) {
  id.value = rule?.id ?? ''
  name.value = rule?.name ?? ''
  description.value = rule?.description ?? ''
  onTypes.value = (rule?.on ?? []).join(', ')
  repoName.value = rule?.repoName ?? ''
  whenText.value = rule?.whenText ?? ''
  enabled.value = rule?.enabled !== false
  exclusive.value = rule?.exclusive === true
  actions.value = rule?.do ? [...rule.do] : []

  const conds = Array.isArray(rule?.when) ? rule.when : []
  whenRows.value = conds.map((c) => ({ field: c.field, op: c.op, value: c.value ?? '' }))
  logics.value = conds.map((c, i) => (i === 0 ? 'and' : (c.logic ?? 'and')))
}

watch(() => props.rule, hydrate, { immediate: true })

const isNew = computed(() => !props.rule)

const idError = computed(() => {
  if (!id.value.trim()) return 'El id es obligatorio'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id.value.trim()))
    return 'Sólo minúsculas, números y guiones'
  return null
})

const onError = computed(() =>
  parsedOnTypes.value.length ? null : 'Al menos un tipo de evento — si no, la regla nunca dispara',
)

const actionsError = computed(() =>
  actions.value.length ? null : 'Al menos una acción — si no, la regla no hace nada',
)

const parsedOnTypes = computed(() =>
  onTypes.value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
)

const canSave = computed(() => !idError.value && !onError.value && !actionsError.value)

function toggleLogic(i: number) {
  const next = [...logics.value]
  next[i] = next[i] === 'or' ? 'and' : 'or'
  logics.value = next
}

function save() {
  if (!canSave.value) return
  const when: WhenCondition[] = whenRows.value
    .filter((r) => r.field.trim())
    .map((r, i) => {
      const cond: WhenCondition = { field: r.field.trim(), op: r.op }
      if (r.op !== '$null' && r.op !== '$not_null') cond.value = r.value.trim()
      if (i > 0) cond.logic = logics.value[i] ?? 'and'
      return cond
    })

  emit('save', {
    id: id.value.trim(),
    name: name.value.trim() || undefined,
    description: description.value.trim() || undefined,
    on: parsedOnTypes.value,
    projectId: props.projectId ?? null,
    repoName: repoName.value.trim() || null,
    when: when.length ? when : undefined,
    whenText: whenText.value.trim() || undefined,
    enabled: enabled.value,
    exclusive: exclusive.value,
    do: actions.value,
  })
}
</script>

<template>
  <div class="rem-backdrop" @click.self="emit('close')">
    <div class="rem" role="dialog" aria-modal="true" aria-label="Editar regla">
      <header class="rem-head">
        <h2 class="rem-title">{{ isNew ? 'Nueva regla' : `Regla ${rule?.id}` }}</h2>
        <button type="button" class="rem-close" aria-label="Cerrar" @click="emit('close')">✕</button>
      </header>

      <div class="rem-body">
        <section class="rem-sec">
          <h3 class="rem-sec-title">Identidad</h3>
          <label class="rem-row">
            <span class="rem-lbl">Id</span>
            <input
              v-model="id"
              class="rem-field rem-mono"
              :disabled="!isNew"
              placeholder="pr-abierto-avisa-y-revisa"
            />
            <span v-if="idError" class="rem-err">{{ idError }}</span>
          </label>
          <label class="rem-row">
            <span class="rem-lbl">Nombre</span>
            <input v-model="name" class="rem-field" placeholder="Avisar y revisar al abrir un PR" />
          </label>
          <label class="rem-row">
            <span class="rem-lbl">Descripción</span>
            <input v-model="description" class="rem-field" placeholder="Opcional" />
          </label>
        </section>

        <section class="rem-sec">
          <h3 class="rem-sec-title">Cuándo dispara</h3>
          <label class="rem-row">
            <span class="rem-lbl">Tipos de evento</span>
            <input
              v-model="onTypes"
              class="rem-field rem-mono"
              placeholder="pr.opened, pr.synchronize"
            />
            <span v-if="onError" class="rem-err">{{ onError }}</span>
            <span v-else class="rem-hint">Separados por coma.</span>
          </label>
        </section>

        <section class="rem-sec">
          <h3 class="rem-sec-title">Sobre qué</h3>
          <p class="rem-scope">
            <template v-if="projectId">
              Se aplica sólo a eventos del proyecto <code>{{ projectId }}</code>.
            </template>
            <template v-else>
              Regla global: ve eventos de cualquier proyecto, y es la única clase que ve un evento
              sin proyecto asignado.
            </template>
          </p>
          <label v-if="projectId" class="rem-row">
            <span class="rem-lbl">Repo</span>
            <select v-if="repoNames?.length" v-model="repoName" class="rem-field">
              <option value="">— cualquiera —</option>
              <option v-for="r in repoNames" :key="r" :value="r">{{ r }}</option>
            </select>
            <input v-else v-model="repoName" class="rem-field rem-mono" placeholder="cualquiera" />
            <span class="rem-hint">Vacío = sin restricción. Con valor, exige proyecto Y repo.</span>
          </label>

          <div class="rem-row">
            <span class="rem-lbl">Condiciones</span>
            <ConditionRowsEditor
              v-model="whenRows"
              :ops="OPS"
              value-placeholder="valor"
            />
            <div v-if="whenRows.length > 1" class="rem-logics">
              <button
                v-for="i in whenRows.length - 1"
                :key="i"
                type="button"
                class="rem-logic"
                :class="logics[i] ?? 'and'"
                @click="toggleLogic(i)"
              >{{ (logics[i] ?? 'and').toUpperCase() }}</button>
            </div>
            <span class="rem-hint">
              Se evalúan contra el payload del evento, incluyendo caminos anidados
              (<code>pr.head.ref</code>).
            </span>
          </div>

          <label class="rem-row">
            <span class="rem-lbl">Criterio en texto libre</span>
            <input
              v-model="whenText"
              class="rem-field"
              placeholder="el PR toca la capa de pagos"
            />
            <span class="rem-hint">Opcional. Un modelo lee el evento y decide si cumple.</span>
          </label>
        </section>

        <section class="rem-sec">
          <h3 class="rem-sec-title">Qué hace</h3>
          <ActionsEditor
            v-model="actions"
            :available-kinds="availableKinds"
            :agent-ids="agentIds"
          />
          <span v-if="actionsError" class="rem-err">{{ actionsError }}</span>
        </section>

        <section class="rem-sec">
          <h3 class="rem-sec-title">Avanzado</h3>
          <label class="rem-check">
            <input v-model="enabled" type="checkbox" />
            <span>Habilitada</span>
          </label>
          <label class="rem-check">
            <input v-model="exclusive" type="checkbox" />
            <span>Exclusiva</span>
          </label>
          <p class="rem-hint">
            Por default disparan <strong>todas</strong> las reglas que matchean. Exclusiva corta a
            las de menor prioridad — recupera el comportamiento de "la primera y basta".
          </p>
        </section>
      </div>

      <footer class="rem-foot">
        <button type="button" class="rem-btn" @click="emit('close')">Cancelar</button>
        <button type="button" class="rem-btn rem-btn-primary" :disabled="!canSave" @click="save">
          Guardar
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.rem-backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.55);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 3rem 1rem;
  z-index: 100;
  overflow-y: auto;
}

.rem {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(46rem, 100%);
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 6rem);
}

.rem-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--panel-hi);
}
.rem-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--fs-body);
  flex: 1 1 auto;
}
.rem-close {
  background: none;
  border: none;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: var(--fs-body-sm);
  padding: 0 0.4ch;
}
.rem-close:hover { color: var(--fg); }

.rem-body {
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
}

.rem-sec {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.rem-sec-title {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
  border-bottom: 1px solid var(--border-mute);
  padding-bottom: 0.2rem;
}

.rem-row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.rem-lbl {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.rem-field {
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: var(--panel-alt);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  width: 100%;
  box-sizing: border-box;
  border-radius: var(--radius-sm);
}
.rem-field:disabled { color: var(--fg-dim); }
.rem-mono { font-family: var(--font-mono); }

.rem-hint,
.rem-scope {
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  line-height: 1.5;
  margin: 0;
}
.rem-hint code,
.rem-scope code {
  font-family: var(--font-mono);
  color: var(--fg-mute);
}
.rem-err {
  font-size: var(--fs-micro);
  color: var(--danger);
}

.rem-logics {
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}
.rem-logic {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  font-weight: 700;
  letter-spacing: var(--tracking-lbl);
  padding: 0 0.4ch;
  height: var(--row-h);
  line-height: var(--row-h);
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--panel-alt);
  border-radius: var(--radius-sm);
}
.rem-logic.and { color: var(--ai); border-color: var(--ai); }
.rem-logic.or { color: var(--warn); border-color: var(--warn); background: var(--yellow-bg); }

.rem-check {
  display: flex;
  align-items: center;
  gap: 0.45ch;
  font-size: var(--fs-body-sm);
  color: var(--fg-mute);
  cursor: pointer;
}

.rem-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--border);
  background: var(--panel-hi);
}
.rem-btn {
  height: var(--row-h);
  padding: 0 1.2ch;
  border: 1px solid var(--border);
  background: var(--panel-alt);
  color: var(--fg-mute);
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.rem-btn:hover { color: var(--fg); border-color: var(--border-hi); }
.rem-btn-primary { color: var(--accent); border-color: var(--accent); }
.rem-btn-primary:disabled { opacity: 0.4; cursor: default; }
</style>
