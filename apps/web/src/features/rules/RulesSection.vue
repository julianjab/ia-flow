<script setup lang="ts">
import type { Rule } from '@ia-flow/shared'
import { computed, onMounted, ref, watch } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import {
  createRule,
  deleteRule,
  fetchActionKinds,
  fetchRules,
  reorderRules,
  type RuleScope,
  updateRule,
} from '@/features/rules/api'
import RuleEditorModal from '@/features/rules/RuleEditorModal.vue'
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

onMounted(load)
watch(() => props.scope, load, { deep: true })

function openNew() {
  editing.value = null
  modalOpen.value = true
}

function openEdit(rule: Rule) {
  editing.value = rule
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
  } catch (e) {
    toast.error(`Error: ${extractErrorMessage(e)}`)
  }
}

async function handleDelete(rule: Rule) {
  try {
    await deleteRule(props.scope, rule.id)
    toast.success(`Regla '${rule.id}' eliminada`)
    await load()
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

function actionSummary(rule: Rule): string {
  return rule.do.map((a) => (a as { action: string }).action).join(' → ')
}
</script>

<template>
  <section class="rs panel">
    <header class="panel__header rs-head">
      <h2 class="rs-title">Reglas</h2>
      <span class="rs-count">{{ rules.length }}</span>
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
    <p v-else-if="!rules.length" class="rs-empty">
      Sin reglas todavía. Una regla conecta un evento con lo que tiene que pasar.
    </p>

    <ul v-else class="rs-list">
      <li v-for="(rule, i) in rules" :key="rule.id" class="rs-item" :class="{ off: rule.enabled === false }">
        <div class="rs-item-main">
          <div class="rs-item-top">
            <span class="rs-id">{{ rule.id }}</span>
            <span v-if="rule.enabled === false" class="rs-tag off">deshabilitada</span>
            <span v-if="rule.exclusive" class="rs-tag excl">exclusiva</span>
            <span v-if="rule.repoName" class="rs-tag repo">{{ rule.repoName }}</span>
          </div>
          <div class="rs-item-sub">
            <span class="rs-on">{{ rule.on.join(', ') }}</span>
            <span class="rs-arrow">→</span>
            <span class="rs-actions">{{ actionSummary(rule) }}</span>
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
</style>
