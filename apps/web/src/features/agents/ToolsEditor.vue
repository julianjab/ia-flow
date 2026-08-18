<script setup lang="ts">
// ToolsEditor — reemplaza PermissionsEditor.vue (issue #58 DSL) y la sección
// "Tools (legacy)". Un solo modelo: `tools[]` es una lista plana de nombres
// de tool; `bash_run` es la única entry con forma de objeto, con su propia
// config de patrones allow/deny (estilo Claude Code `Bash(cmd:*)`, con "*"
// como comodín de token en vez de regex). No hay categorías/presets del lado
// del servidor — el agrupamiento de abajo es sólo cosmético.

import { computed, onMounted, ref, watch } from 'vue'
import type { AgentToolEntry, BashRunConfig } from '@ia-flow/shared'
import PromptEditor from '@/features/prompts/PromptEditor.vue'
import type { VariableGroup } from '@/features/prompts/PromptField.vue'

// Interpolados vía computed en vez de escritos literales en el template: el
// tokenizer de Vue busca el primer "}}" para cerrar una interpolación sin
// entender JS anidado, así que "{{ '{{...}}' }}" en el template rompe el
// parse (cierra en el "}}" de adentro). Con una variable no hay "{{"/"}}"
// literales en el source del template.
const VAR_SYNTAX_EXAMPLE = '{{...}}'
const VAR_BRANCH_EXAMPLE = '{{task.branch}}'

interface ToolDef {
  name: string
  description: string
  aliases: string[]
}

const props = defineProps<{
  tools: AgentToolEntry[] | undefined
  variableGroups?: VariableGroup[]
}>()

const emit = defineEmits<{
  'update:tools': [tools: AgentToolEntry[] | undefined]
}>()

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

const catalog = ref<ToolDef[]>([])

onMounted(async () => {
  try {
    const res = await fetch(`${API_BASE}/api/tools`)
    if (res.ok) catalog.value = (await res.json()) as ToolDef[]
  } catch {
    // server may not be running — the editor stays empty
  }
})

// Agrupamiento puramente visual — no existe como concepto en el schema.
const GROUPS: Array<{ label: string; names: string[] }> = [
  { label: 'Filesystem', names: ['fs_read', 'fs_list', 'fs_grep', 'fs_write', 'fs_edit'] },
  {
    label: 'Task',
    names: [
      'update_issue_body',
      'add_task_comment',
      'set_task_field',
      'set_task_labels',
      'mark_blocked_by',
      'complete_task',
      'fail_task',
    ],
  },
  { label: 'Workspace', names: ['workspace_reset'] },
  { label: 'GitHub', names: ['create_github_issue', 'add_to_project', 'add_sub_issue'] },
  {
    label: 'Slack',
    names: [
      'slack_resolve_permalink',
      'slack_read_thread',
      'slack_channel_history',
      'slack_post_message',
    ],
  },
]

const groupedCatalog = computed(() => {
  const byName = new Map(catalog.value.map((t) => [t.name, t]))
  const used = new Set<string>()
  const groups = GROUPS.map((g) => {
    const items = g.names.map((n) => byName.get(n)).filter((t): t is ToolDef => !!t)
    for (const t of items) used.add(t.name)
    return { label: g.label, items }
  }).filter((g) => g.items.length)
  const rest = catalog.value.filter((t) => !used.has(t.name) && t.name !== 'bash_run')
  if (rest.length) groups.push({ label: 'Otras', items: rest })
  return groups
})

const bashRunDef = computed(() => catalog.value.find((t) => t.name === 'bash_run'))

const stringTools = computed(() => new Set((props.tools ?? []).filter((t): t is string => typeof t === 'string')))
const bashRunEntry = computed<BashRunConfig | undefined>(
  () => (props.tools ?? []).find((t): t is BashRunConfig => typeof t !== 'string'),
)
const bashEnabled = computed(() => bashRunEntry.value !== undefined)

// Drafts para los textareas de allow/deny — una línea por patrón. Se
// commitea en cada cambio (no en blur, PromptEditor no expone ese evento),
// lo que hace que `bashRunEntry` cambie y dispare este watch de vuelta con
// el mismo valor que acabamos de emitir — sin el guard de `lastCommitted`,
// eso pisa lo que el usuario está tipeando en el mismo tick (línea vacía al
// hacer Enter, espacios de borde, cursor saltando al final). Mismo patrón
// `lastEmitted` que ya usa OutcomesEditor.vue.
const allowDraft = ref('')
const denyDraft = ref('')
let lastCommittedAllow: string | null = null
let lastCommittedDeny: string | null = null
watch(
  bashRunEntry,
  (entry) => {
    const nextAllow = (entry?.allow ?? []).join('\n')
    const nextDeny = (entry?.deny ?? []).join('\n')
    if (nextAllow !== lastCommittedAllow) allowDraft.value = nextAllow
    if (nextDeny !== lastCommittedDeny) denyDraft.value = nextDeny
  },
  { immediate: true },
)

function linesFrom(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function emitTools(next: AgentToolEntry[]) {
  emit('update:tools', next.length ? next : undefined)
}

function toggleTool(name: string) {
  const next = (props.tools ?? []).filter((t) => t !== name)
  if (!stringTools.value.has(name)) next.push(name)
  emitTools(next)
}

function toggleBash() {
  const rest = (props.tools ?? []).filter((t) => typeof t === 'string')
  if (bashEnabled.value) {
    emitTools(rest)
  } else {
    emitTools([...rest, { name: 'bash_run', allow: [], deny: [] }])
  }
}

function commitBashPatterns() {
  if (!bashEnabled.value) return
  const allow = linesFrom(allowDraft.value)
  const deny = linesFrom(denyDraft.value)
  // Registrado ANTES de emitir: `entry.allow.join('\n')` va a ser exactamente
  // esto tras el round-trip por el padre, no `allowDraft.value` crudo (que
  // puede tener líneas vacías o espacios de borde que `linesFrom` filtra) —
  // así el watch de arriba sabe que ese cambio de `bashRunEntry` es eco de lo
  // que el usuario acaba de tipear, no una actualización externa.
  lastCommittedAllow = allow.join('\n')
  lastCommittedDeny = deny.join('\n')
  const rest = (props.tools ?? []).filter((t) => typeof t === 'string')
  emitTools([
    ...rest,
    { name: 'bash_run', allow, deny },
  ])
}

function onAllowChange(value: string) {
  allowDraft.value = value
  commitBashPatterns()
}

function onDenyChange(value: string) {
  denyDraft.value = value
  commitBashPatterns()
}
</script>

<template>
  <div class="tools-editor">
    <div v-for="group in groupedCatalog" :key="group.label" class="field">
      <span class="label">{{ group.label }}</span>
      <div class="chip-grid">
        <label
          v-for="tool in group.items"
          :key="tool.name"
          class="chip"
          :class="{ active: stringTools.has(tool.name) }"
          :title="tool.description"
          @click="toggleTool(tool.name)"
        >
          <span class="chip-check">{{ stringTools.has(tool.name) ? '✓' : '' }}</span>
          <span class="chip-mono">{{ tool.name }}</span>
        </label>
      </div>
    </div>

    <div class="field">
      <span class="label">Bash</span>
      <label class="chip bash-toggle" :class="{ active: bashEnabled }" @click="toggleBash">
        <span class="chip-check">{{ bashEnabled ? '✓' : '' }}</span>
        <span class="chip-mono">bash_run</span>
      </label>
      <span class="field-hint" v-if="bashRunDef">{{ bashRunDef.description }}</span>

      <div v-if="bashEnabled" class="bash-panel">
        <span class="field-hint">
          Comandos permitidos — un patrón por línea. Prefijo + tokens, "*"
          como comodín (mismo estilo que Claude Code): "git push origin
          task/*", "npm run *". Sin match en <b>allow</b> = rechazado.
          Soporta variables <code>{{ VAR_SYNTAX_EXAMPLE }}</code> igual que el
          prompt (ej. <code>{{ VAR_BRANCH_EXAMPLE }}</code>), resueltas en cada run.
        </span>
        <PromptEditor
          :model-value="allowDraft"
          :variable-groups="variableGroups ?? []"
          :rows="4"
          @update:model-value="onAllowChange"
        />

        <span class="field-hint">
          Comandos rechazados — gana sobre <b>allow</b> aunque un patrón más
          amplio lo cubra.
        </span>
        <PromptEditor
          :model-value="denyDraft"
          :variable-groups="variableGroups ?? []"
          :rows="2"
          @update:model-value="onDenyChange"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.tools-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--fg-mute);
}
.field-hint {
  font-size: 0.73rem;
  color: var(--fg-dim);
  line-height: 1.4;
}
.chip-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.chip {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.65rem;
  border: 1px solid var(--border-hi);
  font-size: 0.78rem;
  color: var(--fg-mute);
  cursor: pointer;
  user-select: none;
  background: var(--panel);
  transition: border-color 0.1s, background 0.1s;
  width: fit-content;
}
.chip:hover {
  border-color: var(--info);
  color: var(--info);
}
.chip.active {
  border-color: var(--info);
  background: var(--panel-hi);
  color: var(--info);
  font-weight: 500;
}
.chip-check {
  width: 0.8rem;
  font-size: 0.72rem;
  color: var(--info);
}
.chip-mono {
  font-family: var(--font-mono);
}
.bash-panel {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  border-left: 1px solid var(--border);
  padding-left: 0.6rem;
  margin-top: 0.3rem;
}
</style>
