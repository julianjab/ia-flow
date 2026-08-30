<script setup lang="ts">
import type { Rule, RuleActionEntry, WhenCondition } from '@ia-flow/shared'
import { computed, ref, watch } from 'vue'
import ActionsEditor from '@/features/rules/ActionsEditor.vue'
import type { ConditionRow } from '@/ui/condition-rows'
import EventTypePicker from '@/features/rules/EventTypePicker.vue'
import { recurringRuleWarning } from '@/features/rules/rule-templates'
import RuleScopeEditor from '@/features/rules/RuleScopeEditor.vue'

// Editor de una regla. Las cuatro secciones siguen el orden en que se lee la
// regla en voz alta: cuándo dispara (evento), sobre qué (ámbito + condiciones),
// y qué hace (acciones).

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

// `when` viaja como WhenCondition[] pero la fila compartida no conoce `logic`
// (el conector con la anterior). Se preserva por índice al serializar en vez de
// perderse: una regla guardada con un OR tiene que volver siendo la misma.
const logics = ref<Array<'and' | 'or'>>([])

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
  () => hydrate(props.rule),
  { immediate: true },
)

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
    schedule: schedule.value.trim() || undefined,
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
            <EventTypePicker v-model="onTypes" />
            <span v-if="onError" class="rem-err">{{ onError }}</span>
            <span v-else class="rem-hint">Separados por coma.</span>
            <span v-if="recurringWarning" class="rem-warn">⚠ {{ recurringWarning }}</span>
          </label>
        </section>

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

        <section class="rem-sec">
          <h3 class="rem-sec-title">Qué hace</h3>
          <ActionsEditor
            v-model="actions"
            :available-kinds="availableKinds"
            :agent-ids="agentIds"
            :action-ids="actionIds"
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
        <!-- Borrar vive acá y no en la fila del listado: se hace una vez, no
             se deshace, y desde acá se ve exactamente QUÉ regla se está por
             borrar en vez de un ✕ pegado al gesto de reordenar. -->
        <button
          v-if="!isNew && rule"
          type="button"
          class="rem-btn rem-btn-danger"
          @click="emit('delete', rule)"
        >
          Eliminar
        </button>
        <span class="rem-foot-spacer" />
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

.rem-hint {
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  line-height: 1.5;
  margin: 0;
}
.rem-hint code {
  font-family: var(--font-mono);
  color: var(--fg-mute);
}
.rem-warn {
  font-size: var(--fs-micro);
  color: var(--warn);
  line-height: 1.5;
}
.rem-err {
  font-size: var(--fs-micro);
  color: var(--danger);
}


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
  align-items: center;
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
.rem-btn-danger { color: var(--fg-dim); }
.rem-btn-danger:hover { color: var(--danger); border-color: var(--danger); background: var(--red-bg); }
.rem-foot-spacer { flex: 1 1 auto; }
.rem-btn-primary:disabled { opacity: 0.4; cursor: default; }
</style>
