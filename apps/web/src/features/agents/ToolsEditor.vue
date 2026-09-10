<script setup lang="ts">
import { fetchToolCatalog, type ToolCatalogEntry } from '@/features/agents/api';
// ToolsEditor — reemplaza PermissionsEditor.vue (issue #58 DSL) y la sección
// "Tools (legacy)". Un solo modelo: `tools[]` es una lista plana de nombres
// de tool; `bash_run` es la única entry con forma de objeto, con su propia
// config de patrones allow/deny (estilo Claude Code `Bash(cmd:*)`, con "*"
// como comodín de token en vez de regex). No hay categorías/presets del lado
// del servidor — el agrupamiento de abajo es sólo cosmético.

import { computed, onMounted, ref, watch } from 'vue'
import type { AgentToolEntry, BashRunConfig } from '@ia-flow/shared'

type ToolDef = ToolCatalogEntry

const props = defineProps<{
  tools: AgentToolEntry[] | undefined
}>()

const emit = defineEmits<{
  'update:tools': [tools: AgentToolEntry[] | undefined]
}>()

const catalog = ref<ToolDef[]>([])

onMounted(async () => {
  try {
    catalog.value = await fetchToolCatalog()
  } catch {
    // server may not be running — the editor stays empty
  }
})

// Agrupamiento puramente visual — no existe como concepto en el schema.
const GROUPS: Array<{ label: string; names: string[] }> = [
  { label: 'Filesystem', names: ['fs_read', 'fs_list', 'fs_grep', 'fs_glob', 'fs_write', 'fs_edit'] },
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
  {
    label: 'GitHub',
    names: ['create_github_issue', 'add_to_project', 'add_sub_issue', 'list_sub_issues_brief'],
  },
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

// Drafts para los textareas de allow/deny — una línea por patrón.
const allowDraft = ref('')
const denyDraft = ref('')
watch(
  bashRunEntry,
  (entry) => {
    allowDraft.value = (entry?.allow ?? []).join('\n')
    denyDraft.value = (entry?.deny ?? []).join('\n')
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
  const rest = (props.tools ?? []).filter((t) => typeof t === 'string')
  emitTools([
    ...rest,
    { name: 'bash_run', allow: linesFrom(allowDraft.value), deny: linesFrom(denyDraft.value) },
  ])
}
</script>

<template>
  <div class="tools-editor">
    <div v-for="group in groupedCatalog" :key="group.label" class="ff-row">
      <span class="uc-label">{{ group.label }}</span>
      <div class="ff-chips">
        <label
          v-for="tool in group.items"
          :key="tool.name"
          class="ff-chip"
          :class="{ 'ff-chip--on': stringTools.has(tool.name) }"
          :title="tool.description"
          @click="toggleTool(tool.name)"
        >
          <span class="ff-chip-check">{{ stringTools.has(tool.name) ? '✓' : '' }}</span>
          <span class="ff-chip-mono">{{ tool.name }}</span>
        </label>
      </div>
    </div>

    <div class="ff-row">
      <span class="uc-label">Bash</span>
      <div class="ff-chips">
        <label
          class="ff-chip"
          :class="{ 'ff-chip--on': bashEnabled }"
          @click="toggleBash"
        >
          <span class="ff-chip-check">{{ bashEnabled ? '✓' : '' }}</span>
          <span class="ff-chip-mono">bash_run</span>
        </label>
      </div>
      <p class="ff-hint" v-if="bashRunDef">{{ bashRunDef.description }}</p>

      <div v-if="bashEnabled" class="bash-panel">
        <p class="ff-hint">
          Comandos permitidos — un patrón por línea. Prefijo + tokens, "*"
          como comodín (mismo estilo que Claude Code): "git push origin
          task/*", "npm run *". Sin match en <b>allow</b> = rechazado.
        </p>
        <textarea
          v-model="allowDraft"
          class="ff-field ff-textarea ff-mono"
          rows="4"
          spellcheck="false"
          placeholder="git status&#10;git push origin task/*&#10;npm run *"
          @blur="commitBashPatterns"
        ></textarea>

        <p class="ff-hint">
          Comandos rechazados — gana sobre <b>allow</b> aunque un patrón más
          amplio lo cubra.
        </p>
        <textarea
          v-model="denyDraft"
          class="ff-field ff-textarea ff-mono"
          rows="2"
          spellcheck="false"
          placeholder="git push origin main*"
          @blur="commitBashPatterns"
        ></textarea>
      </div>
    </div>
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
.tools-editor {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
/* El allow/deny cuelga del chip que lo habilita: la barra a la izquierda es
   lo que dice que estos dos textarea pertenecen a `bash_run` y no al grupo de
   tools de arriba. */
.bash-panel {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  border-left: 1px solid var(--border);
  padding-left: 0.6rem;
  margin-top: 0.3rem;
}
</style>
