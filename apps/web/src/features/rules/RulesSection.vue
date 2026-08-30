<script setup lang="ts">
import type { Pipeline, RunningAgent } from '@ia-flow/shared'
import type { Rule } from '@ia-flow/shared'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import {
  createRule,
  deleteRule,
  fetchActionKinds,
  fetchPipeline,
  fetchRules,
  reorderRules,
  type RuleScope,
  updateRule,
} from '@/features/rules/api'
import RuleEditorModal from '@/features/rules/RuleEditorModal.vue'
import { RULE_TEMPLATES, type RuleTemplate } from '@/features/rules/rule-templates'
import RuleSentence from '@/features/rules/RuleSentence.vue'
import ConfirmDialog from '@/ui/ConfirmDialog.vue'
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

const modalOpen = ref(false)
const editing = ref<Rule | null>(null)
const confirmDelete = ref<Rule | null>(null)

const projectId = computed(() => (props.scope.kind === 'project' ? props.scope.projectId : null))

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [list, kinds] = await Promise.all([fetchRules(props.scope), fetchActionKinds()])
    rules.value = list.rules
    readOnly.value = list.readOnly
    actionKinds.value = kinds
  } catch (e) {
    loadError.value = extractErrorMessage(e)
  } finally {
    loading.value = false
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
  template.value = null
  pickerOpen.value = true
}

function startFrom(t: RuleTemplate) {
  template.value = t.build()
  pickerOpen.value = false
  modalOpen.value = true
}

function openEdit(rule: Rule) {
  editing.value = rule
  template.value = null
  modalOpen.value = true
}

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
    await load()
    void loadLive()
  } catch (e) {
    toast.error(`Error: ${extractErrorMessage(e)}`)
  }
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

async function move(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= rules.value.length) return
  const ids = rules.value.map((r) => r.id)
  const [moved] = ids.splice(index, 1)
  ids.splice(target, 0, moved)
  // Optimista: reordenar es barato de revertir (un reload) y esperar el
  // round-trip para ver moverse la fila se siente roto.
  const previous = rules.value
  rules.value = ids.map((id) => previous.find((r) => r.id === id)!).filter(Boolean)
  try {
    await reorderRules(props.scope, ids)
  } catch (e) {
    rules.value = previous
    toast.error(`Error al reordenar: ${extractErrorMessage(e)}`)
  }
}

</script>

<template>
  <section class="rs panel">
    <header class="panel__header rs-head">
      <h2 class="rs-title">Reglas</h2>
      <span class="rs-count">{{ rules.length }}</span>
      <span v-if="live?.running.length" class="rs-running">◐ {{ live.running.length }} corriendo</span>
      <div class="rs-spacer" />
      <button v-if="!readOnly" type="button" class="rs-add" @click="openNew">+ regla</button>
    </header>

    <p class="rs-lede">
      Cuando pasa un evento, las reglas que lo matchean ejecutan sus acciones.
      <template v-if="projectId">
        Éstas se aplican sólo a eventos de <code>{{ projectId }}</code>.
      </template>
      <template v-else>Éstas son globales: ven eventos de cualquier proyecto.</template>
    </p>

    <p v-if="readOnly" class="rs-note">
      Sólo lectura — las reglas de este deploy vienen del YAML.
    </p>
    <p v-if="loadError" class="rs-error">{{ loadError }}</p>
    <p v-else-if="loading" class="rs-empty">Cargando…</p>
    <p v-else-if="!rules.length && !pickerOpen" class="rs-empty">
      Sin reglas todavía. Una regla conecta un evento con lo que tiene que pasar.
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

    <ul v-else-if="rules.length" class="rs-list">
      <li v-for="(rule, i) in rules" :key="rule.id" class="rs-item" :class="{ off: rule.enabled === false }">
        <div class="rs-item-main">
          <div class="rs-item-top">
            <span class="rs-id">{{ rule.id }}</span>
            <span v-if="rule.enabled === false" class="rs-tag off">deshabilitada</span>
            <span v-if="rule.exclusive" class="rs-tag excl">exclusiva</span>
            <span v-if="rule.repoName" class="rs-tag repo">{{ rule.repoName }}</span>
          </div>
          <RuleSentence :rule="rule" />
          <div v-if="runsByRule.get(rule.id)?.length" class="rs-live">
            <span v-for="run in runsByRule.get(rule.id)" :key="run.taskId" class="rs-run">
              ◐ {{ runLabel(run) }}<span v-if="run.isSubAgent" class="rs-tag">sub</span>
            </span>
          </div>
          <p v-if="rule.name" class="rs-name">{{ rule.name }}</p>
        </div>
        <div v-if="!readOnly" class="rs-item-ops">
          <button type="button" class="rs-icon" :disabled="i === 0" aria-label="Subir" @click="move(i, -1)">↑</button>
          <button
            type="button"
            class="rs-icon"
            :disabled="i === rules.length - 1"
            aria-label="Bajar"
            @click="move(i, 1)"
          >↓</button>
          <button type="button" class="rs-icon" aria-label="Editar" @click="openEdit(rule)">✎</button>
          <button type="button" class="rs-icon danger" aria-label="Eliminar" @click="confirmDelete = rule">✕</button>
        </div>
      </li>
    </ul>

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

    <RuleEditorModal
      v-if="modalOpen"
      :rule="editing"
      :available-kinds="actionKinds"
      :agent-ids="agentIds"
      :repo-names="repoNames"
      :project-id="projectId"
      @save="handleSave"
      @close="modalOpen = false"
    />

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
</template>

<style scoped>
.rs { display: flex; flex-direction: column; }

.rs-head { display: flex; align-items: center; gap: 0.5ch; }
.rs-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--fs-body);
}
.rs-count {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.rs-spacer { flex: 1 1 auto; }
.rs-add {
  background: none;
  border: 1px dashed var(--border);
  color: var(--fg-dim);
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  height: var(--row-h);
  padding: 0 1ch;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.rs-add:hover { border-color: var(--accent); color: var(--accent); }

.rs-lede,
.rs-note,
.rs-empty,
.rs-error {
  margin: 0;
  padding: 0.4rem 0.6rem;
  font-size: var(--fs-body-sm);
  color: var(--fg-mute);
  line-height: 1.5;
}
.rs-lede code { font-family: var(--font-mono); }
.rs-note { color: var(--warn); }
.rs-empty { color: var(--fg-dimmer); }
.rs-error { color: var(--danger); }

.rs-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.rs-item {
  display: flex;
  align-items: flex-start;
  gap: 0.5ch;
  padding: 0.35rem 0.6rem;
  border-top: 1px solid var(--border-mute);
}
.rs-item:hover { background: var(--panel-hi); }
.rs-item.off { opacity: 0.55; }

.rs-item-main { flex: 1 1 auto; min-width: 0; }
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

.rs-name {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}

.rs-item-ops { display: flex; gap: 0.1ch; flex: none; }
.rs-icon {
  background: none;
  border: none;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: var(--fs-micro);
  height: var(--row-h);
  line-height: var(--row-h);
  padding: 0 0.4ch;
}
.rs-icon:hover:not(:disabled) { color: var(--fg); }
.rs-icon:disabled { opacity: 0.3; cursor: default; }
.rs-icon.danger { color: var(--danger); }
.rs-icon.danger:hover { color: var(--fg); background: var(--danger); }

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