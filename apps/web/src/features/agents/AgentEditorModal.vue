<script setup lang="ts">
import { apiBase } from '@/features/servers/selection';
import { ref, computed, watch } from 'vue';
import AgentDefinitionSection from '@/features/agents/AgentDefinitionSection.vue';
import OutcomesEditor from '@/features/agents/OutcomesEditor.vue';
import ToolsEditor from '@/features/agents/ToolsEditor.vue';
import type { KV } from '@/features/prompts/PromptField.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProvidersStore } from '@/features/providers/store';
import { useProjectsStore } from '@/features/projects/store';
import type { AgentDefinition, AgentOutcomes, AgentProviderChoice, AgentToolEntry, McpCatalogEntry, SystemPromptDef, SystemPromptRef, WhenCondition } from '@ia-flow/shared';
import { normalizeWhen, type ProjectField } from '@/features/agents/outcomes-serialization';
import { fetchProjectFields, fetchProjectStatuses } from '@/features/projects/sourceApi';
import { useAgentVariableGroups } from '@/composables/useAgentVariableGroups';

interface ToolDef { name: string; description: string }

const props = defineProps<{
  open: boolean;
  agent: AgentDefinition | null;  // null = new agent
  // Scope this editor was opened from — decides whether "Proyecto" is fixed
  // to the active project or shown as "Global". Mirrors AgentesSection's
  // own `scope` prop so activation criteria stay consistent with where the
  // agent will be saved.
  scope?: 'project' | 'global';
  // Optional override for the sysprompt picker. When omitted, falls back to
  // projectConfigStore.config.systemPrompts (legacy single-scope behaviour).
  availableSystemPrompts?: SystemPromptDef[];
  // true for a global agent viewed from a project (always read-only there)
  // or an agent whose source repo rejects writes (see AgentesSection's
  // sourceReadOnly, fed by IAgentRepository.isReadOnly()). Hides the Save
  // button — Cancelar becomes the only way out — so the user can still open
  // and read every section without a false affordance to edit. Fields
  // themselves stay as normal inputs (nothing calls the save API without
  // that button), this is intentionally the simple version.
  readonly?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  save: [agent: AgentDefinition];
  delete: [agent: AgentDefinition];
}>();

const projectConfigStore = useProjectConfigStore();
const providersStore     = useProvidersStore();
const projectsStore      = useProjectsStore();

const activationScope = computed<'project' | 'global'>(() => props.scope ?? 'project');
const activationProjectId = computed(() =>
  activationScope.value === 'project' ? projectsStore.activeProjectId : null,
);
const activationProjectName = computed(() =>
  activationScope.value === 'project' ? (projectsStore.activeProject?.name ?? null) : null,
);

// Field + status catalogs for the Outcomes editor. `Labels` arrives with its
// `options` populated by the server (labels seen across the project's items),
// which is what feeds the label picker de los outcomes.
const outcomesProjectFields = ref<ProjectField[]>([]);
const outcomesStatusOptions = ref<string[]>([]);

async function loadOutcomesCatalogs() {
  const pid = activationProjectId.value;
  if (!pid) {
    outcomesProjectFields.value = [];
    outcomesStatusOptions.value = [];
    return;
  }
  try {
    const res = await fetchProjectFields(pid);
    outcomesProjectFields.value = (res.fields ?? []).map((f) => ({
      name: f.name,
      dataType: f.dataType,
      options: f.options ?? [],
    }));
  } catch { outcomesProjectFields.value = []; }
  try {
    const res = await fetchProjectStatuses(pid);
    outcomesStatusOptions.value = (res.statuses ?? []).map((s) => s.name);
  } catch { outcomesStatusOptions.value = []; }
}

watch(() => [props.open, activationProjectId.value], ([open]) => {
  if (open) void loadOutcomesCatalogs();
});

const API_BASE = apiBase();

// ─── Form state ───────────────────────────────────────────────────────────────

const agentId            = ref('');
// Siempre un array — el usuario tilda uno o varios candidatos vía
// ProviderChoicesEditor y arrastra para fijar el orden de fallback. onSave
// decide si lo que se guarda es el string plano original (1 candidato, sin
// whenText) o el array completo (ver AgentProviderSchema).
const providerChoices = ref<AgentProviderChoice[]>([{ providerId: 'anthropic-api' }]);
const prompt             = ref('');
const variables          = ref<KV[]>([]);
const tools               = ref<AgentToolEntry[] | undefined>(undefined);
const selectedSysprompts = ref<string[]>([]);
// `AgentDefinition.systemPrompts` puede traer entradas `{text}` inline
// (puestas a mano en un deploy YAML headless) mezcladas con ids — este
// editor solo administra la parte string vía checkboxes, así que preserva
// cualquier `{text}` tal cual para no perderlo al guardar (ver onSave).
const preservedSystemPromptRefs = ref<SystemPromptRef[]>([]);
const providerConfigDraft = ref<Record<string, unknown>>({});
const selectedMcpCatalogIds = ref<string[]>([]);
const availableMcpCatalog = ref<McpCatalogEntry[]>([]);
const availableTools     = ref<ToolDef[]>([]);
const errors             = ref<string[]>([]);
const saving             = ref(false);
// Gate explícito para auto-crear una linked branch en GitHub. Tri-state:
//   null → engine deriva del set de tools · true → siempre · false → nunca.
const requiresBranch = ref<boolean | null>(null);

// La activación se fue a `rules` (migración 059): el agente ya no declara
// CUÁNDO corre. `allowBlocked` se quedó porque no es un criterio de match sino
// una tolerancia del trabajo que el agente hace — ver AgentDefinitionSchema.
const allowBlocked = ref(false);
const maxConcurrentDispatches = ref<number | null>(null);

// ─── Outcomes (see AgentOutcomesSchema) — $set:/$labels: strings per slot
const outcomes = ref<AgentOutcomes>({});

const agentVariableGroups = useAgentVariableGroups();

const isNew = computed(() => props.agent === null);
const title = computed(() => {
  if (isNew.value) return 'Nuevo agente';
  return props.readonly ? `Ver agente — ${props.agent?.id}` : `Editar agente — ${props.agent?.id}`;
});

const providers           = computed(() => providersStore.providers);
const availableSysprompts = computed<SystemPromptDef[]>(() =>
  props.availableSystemPrompts ?? projectConfigStore.config?.systemPrompts ?? [],
);

// ─── Section summaries ────────────────────────────────────────────────────
// Lo que se ve cuando la sección está plegada. Deben responder "¿qué hay acá
// adentro?" sin abrirla — si no hay nada configurado, decirlo explícitamente
// en vez de dejar el resumen vacío.

const definitionSummary = computed(() => {
  const choices = providerChoices.value;
  const first = providers.value.find((x) => x.id === choices[0]?.providerId)?.name ?? choices[0]?.providerId ?? '—';
  const name = choices.length > 1 ? `${first} +${choices.length - 1} más` : first;
  return prompt.value.trim() ? name : `${name} · sin prompt`;
});

const toolsSummary = computed(() => {
  const t = (tools.value ?? []).length;
  const m = selectedMcpCatalogIds.value.length;
  if (!t && !m) return 'sin configurar';
  const parts: string[] = [];
  if (t) parts.push(`${t} tool${t === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} MCP`);
  return parts.join(' · ');
});

// Las que el agente puede pedir por nombre: todas menos las dos reservadas,
// que el engine elige solo según cómo terminó el run.
const selectableExitNames = computed(() =>
  Object.keys(outcomes.value.exits ?? {}).filter((n) => n !== 'success' && n !== 'error'),
);

const outcomesSummary = computed(() => {
  const o = outcomes.value;
  const names = Object.keys(o.exits ?? {});
  const parts = [
    o.onProcess ? 'al arrancar' : null,
    names.length ? `${names.length} salida${names.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'sin configurar';
});

// Misma regla que el engine deriva server-side cuando `requiresBranch` es
// null (ver AgentOrchestrator) — mostrarla acá evita que "Auto" sea una caja
// negra que obliga a leer el field-hint para saber qué hace en este agente.
const WRITE_TOOL_NAMES = new Set(['fs_write', 'fs_edit', 'bash_run']);
const derivedRequiresBranch = computed(() =>
  (tools.value ?? []).some((t) => typeof t === 'string' && WRITE_TOOL_NAMES.has(t)),
);
const derivedRequiresBranchReason = computed(() => {
  const matched = (tools.value ?? []).filter(
    (t): t is string => typeof t === 'string' && WRITE_TOOL_NAMES.has(t),
  );
  return matched.length ? `tiene ${matched.join(', ')}` : 'sin write tools';
});

const advancedSummary = computed(() =>
  requiresBranch.value === null
    ? `branch: auto → ${derivedRequiresBranch.value ? 'sí' : 'no'}`
    : requiresBranch.value
      ? 'branch: siempre'
      : 'branch: nunca',
);

// ─── Rail de secciones — reemplaza el stack de acordeones. Cada entrada
// resuelve su propio "¿hay algo que atender acá?" para el punto de estado;
// `danger` para Definición sin prompt es el único caso bloqueante hoy. ────

type SectionKey = 'definicion' | 'herramientas' | 'outcomes' | 'avanzado';
type SectionDot = 'good' | 'neutral' | 'danger';

const activeSection = ref<SectionKey>('definicion');

const sections = computed<{ key: SectionKey; title: string; summary: string; dot: SectionDot }[]>(() => [
  {
    key: 'definicion',
    title: 'Definición',
    summary: definitionSummary.value,
    dot: prompt.value.trim() ? 'good' : 'danger',
  },
  {
    key: 'herramientas',
    title: 'Herramientas y MCP',
    summary: toolsSummary.value,
    dot: (tools.value?.length || selectedMcpCatalogIds.value.length) ? 'good' : 'neutral',
  },
  {
    key: 'outcomes',
    title: 'Outcomes',
    summary: outcomesSummary.value,
    dot: (outcomes.value.onProcess || Object.keys(outcomes.value.exits ?? {}).length) ? 'good' : 'neutral',
  },
  { key: 'avanzado', title: 'Avanzado', summary: advancedSummary.value, dot: 'neutral' },
]);

// ─── "Cómo se comporta" — traduce el form a una oración, para verificar de
// un vistazo que el agente hace lo que uno cree sin reconstruirlo campo por
// campo. Ver auditoría de usabilidad del editor de agentes. ────────────────

const scopeLabel = computed(() =>
  activationScope.value === 'global' ? 'cualquier proyecto' : (activationProjectName.value ?? 'este proyecto'),
);

const providerDisplayName = computed(() => {
  const choices = providerChoices.value;
  const first = providers.value.find((x) => x.id === choices[0]?.providerId)?.name ?? choices[0]?.providerId ?? '—';
  return choices.length > 1 ? `${first} (+${choices.length - 1} más)` : first;
});

const checklist = computed(() => [
  { label: agentId.value.trim() ? 'ID válido' : 'Falta el ID', ok: !!agentId.value.trim() },
  {
    label: providerChoices.value.length ? 'Provider configurado' : 'Falta el provider',
    ok: providerChoices.value.length > 0,
  },
  { label: prompt.value.trim() ? 'Prompt con contenido' : 'Falta el prompt', ok: !!prompt.value.trim() },
]);

// Seed the first sysprompt for a new agent once the list arrives async.
watch(availableSysprompts, (list) => {
  if (!props.open) return;
  if (!isNew.value) return;
  if (selectedSysprompts.value.length) return;
  if (!list.length) return;
  selectedSysprompts.value = [list[0].id];
});

// ─── Hydrate on open ──────────────────────────────────────────────────────────

watch(() => props.open, async (open) => {
  if (!open) return;
  errors.value = [];
  activeSection.value = 'definicion';
  const a = props.agent;
  if (a) {
    agentId.value             = a.id;
    providerChoices.value = Array.isArray(a.provider)
      ? [...a.provider]
      : [{ providerId: a.provider }];
    prompt.value              = a.prompt;
    variables.value           = Object.entries(a.variables ?? {}).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : value.value }));
    tools.value                = a.tools ? [...a.tools] : undefined;
    selectedSysprompts.value   = (a.systemPrompts ?? []).filter((r): r is string => typeof r === 'string');
    preservedSystemPromptRefs.value = (a.systemPrompts ?? []).filter((r) => typeof r !== 'string');
    providerConfigDraft.value = { ...(a.providerConfig ?? {}) };
    selectedMcpCatalogIds.value = [...(a.mcpCatalogIds ?? [])];
    requiresBranch.value = a.requiresBranch ?? null;
    allowBlocked.value = a.allowBlocked ?? false;
    maxConcurrentDispatches.value = a.maxConcurrentDispatches ?? null;
    outcomes.value = { onProcess: a.onProcess, exits: a.exits };
  } else {
    agentId.value             = '';
    providerChoices.value = [{ providerId: providers.value[0]?.id ?? 'anthropic-api' }];
    prompt.value              = '';
    variables.value           = [];
    tools.value                = undefined;
    selectedSysprompts.value  = availableSysprompts.value[0]?.id
      ? [availableSysprompts.value[0].id]
      : [];
    preservedSystemPromptRefs.value = [];
    providerConfigDraft.value = {};
    selectedMcpCatalogIds.value = [];
    requiresBranch.value = null;
    allowBlocked.value = false;
    maxConcurrentDispatches.value = null;
    outcomes.value = {};
  }

  if (!availableTools.value.length) {
    try {
      const res = await fetch(`${API_BASE}/api/tools`);
      if (res.ok) availableTools.value = await res.json();
    } catch { /* server may not be running */ }
  }

  try {
    const res = await fetch(`${API_BASE}/api/mcp-catalog`);
    if (res.ok) {
      const data = await res.json() as { entries: McpCatalogEntry[] };
      availableMcpCatalog.value = data.entries;
    }
  } catch { /* server may not be running */ }
});

// Reset per-agent providerConfig when the primary provider changes — each
// provider owns its own shape, mixing them makes no sense.
watch(
  () => providerChoices.value[0]?.providerId,
  (next, prev) => {
    if (next === prev) return;
    providerConfigDraft.value = {};
  },
);

// ─── Toggles ─────────────────────────────────────────────────────────────────

// El AI-assist de "Definición" sugiere una lista plana de nombres de tool.
// Los mergeamos con lo ya seleccionado, preservando la entry `bash_run` (que
// no es un nombre plano) si existía.
function applyToolNames(names: string[]) {
  const bashEntry = (tools.value ?? []).find((t) => typeof t !== 'string');
  const next: AgentToolEntry[] = [...names];
  if (bashEntry) next.push(bashEntry);
  tools.value = next.length ? next : undefined;
}

function toggleMcpCatalog(id: string) {
  const idx = selectedMcpCatalogIds.value.indexOf(id);
  if (idx === -1) selectedMcpCatalogIds.value.push(id);
  else selectedMcpCatalogIds.value.splice(idx, 1);
}

// ─── Validation & save ────────────────────────────────────────────────────────

function kvToRecord(list: KV[]): Record<string, string> {
  return Object.fromEntries(list.filter(kv => kv.key).map(kv => [kv.key, kv.value]));
}

function validate(): boolean {
  errors.value = [];
  if (!agentId.value.trim()) errors.value.push('El id es requerido.');
  if (/\s/.test(agentId.value)) errors.value.push('El id no puede tener espacios.');
  if (!providerChoices.value.length || providerChoices.value.some((c) => !c.providerId.trim())) {
    errors.value.push('El provider es requerido — tildá al menos uno.');
  }
  if (!prompt.value.trim()) errors.value.push('El prompt es requerido.');
  // Los tres campos validados viven en "Definición" — si el error cayó en
  // otra sección del rail, el usuario nunca lo vería.
  if (errors.value.length) activeSection.value = 'definicion';
  return errors.value.length === 0;
}

function onSave() {
  if (!validate()) return;
  const choices = providerChoices.value;
  // 1 candidato sin whenText es indistinguible de "un solo provider" — se
  // guarda como el string plano original (forma legacy, sigue siendo válida
  // — ver AgentProviderSchema) en vez de forzar el array a todo agente.
  const provider =
    choices.length === 1 && !choices[0]?.whenText ? choices[0]?.providerId ?? '' : choices;
  const agent: AgentDefinition = {
    id: agentId.value.trim(),
    provider,
    prompt: prompt.value,
  };
  // Las entradas {text} preservadas (no editables acá) van primero, seguidas
  // de los ids que sí administra este editor — no reconstruye el orden
  // original si venían intercaladas, pero no pierde ninguna.
  const systemPromptRefs: SystemPromptRef[] = [
    ...preservedSystemPromptRefs.value,
    ...selectedSysprompts.value,
  ];
  if (systemPromptRefs.length) agent.systemPrompts = systemPromptRefs;
  const vars = kvToRecord(variables.value);
  if (Object.keys(vars).length) agent.variables = vars;
  if (tools.value?.length) agent.tools = [...tools.value];
  const pc = buildProviderConfig();
  if (pc) agent.providerConfig = pc;
  if (selectedMcpCatalogIds.value.length)
    agent.mcpCatalogIds = [...selectedMcpCatalogIds.value];
  if (requiresBranch.value !== null) agent.requiresBranch = requiresBranch.value;
  if (allowBlocked.value) agent.allowBlocked = true;
  if (maxConcurrentDispatches.value) agent.maxConcurrentDispatches = maxConcurrentDispatches.value;
  Object.assign(agent, outcomes.value);
  emit('save', agent);
}

function buildProviderConfig(): Record<string, unknown> | undefined {
  const draft = providerConfigDraft.value;
  return draft && Object.keys(draft).length > 0 ? { ...draft } : undefined;
}

</script>

<template>
  <div v-if="open" class="overlay">
    <div class="page">

      <div class="page-head">
        <button class="back-btn" aria-label="Cerrar" @click="emit('close')">←</button>
        <h3>{{ title }}</h3>
        <div class="page-head-spacer"></div>
        <!-- Borrar vive acá y no en la fila del listado: se hace una vez, no se
             deshace, y desde el detalle se ve exactamente QUÉ agente se está
             por borrar. -->
        <button
          v-if="!readonly && !isNew && agent"
          class="btn btn--danger"
          @click="emit('delete', agent)"
        >Eliminar</button>
        <button class="btn" @click="emit('close')">{{ readonly ? 'Cerrar' : 'Cancelar' }}</button>
        <button
          v-if="!readonly"
          class="btn btn--primary"
          :disabled="saving"
          @click="onSave"
        >Guardar agente</button>
      </div>

      <p v-if="readonly" class="readonly-banner">
        Solo lectura — este agente no se puede guardar desde acá.
      </p>

      <div class="page-shell">

        <!-- ── Rail de secciones — responde "¿qué hay acá?" sin entrar. ── -->
        <nav class="rail">
          <button
            v-for="s in sections"
            :key="s.key"
            type="button"
            class="rail-item"
            :class="{ 'rail-item--active': activeSection === s.key }"
            @click="activeSection = s.key"
          >
            <span class="rail-head">
              <span class="rail-dot" :class="`rail-dot--${s.dot}`"></span>
              <span class="rail-title">{{ s.title }}</span>
            </span>
            <span class="rail-sub">{{ s.summary }}</span>
          </button>
        </nav>

        <!-- ── Panel principal — una sección a la vez. ── -->
        <div class="page-main">

          <section v-show="activeSection === 'definicion'" class="section">
            <AgentDefinitionSection
              :agent-id="agentId"
              :is-new="isNew"
              :provider-choices="providerChoices"
              :providers="providers"
              :provider-config="providerConfigDraft"
              :prompt="prompt"
              :variables="variables"
              :agent-variable-groups="agentVariableGroups"
              :selected-sysprompts="selectedSysprompts"
              :available-sysprompts="availableSysprompts"
              :available-tools="availableTools"
              @update:agent-id="agentId = $event"
              @update:provider-choices="providerChoices = $event"
              @update:provider-config="providerConfigDraft = $event"
              @update:prompt="prompt = $event"
              @update:variables="variables = $event"
              @update:selected-sysprompts="selectedSysprompts = $event"
              @apply-tools="applyToolNames"
            />
          </section>

          <section v-show="activeSection === 'herramientas'" class="section">
            <ToolsEditor
              :tools="tools"
              @update:tools="tools = $event"
            />

            <div class="field">
              <span class="label">MCP Servers (catálogo)</span>
              <span class="field-hint">
                Entradas del catálogo MCP a inyectar en runtime. Los overrides inline del
                <code>providerConfig.mcpServers</code> tienen precedencia.
                <span v-if="!availableMcpCatalog.length">Sin entradas — creá una en General → MCP Catalog.</span>
              </span>
              <div v-if="availableMcpCatalog.length" class="chip-grid">
                <label
                  v-for="entry in availableMcpCatalog"
                  :key="entry.id"
                  class="chip"
                  :class="{ active: selectedMcpCatalogIds.includes(entry.id) }"
                  :title="entry.description ?? entry.name"
                  @click="toggleMcpCatalog(entry.id)"
                >
                  <span class="chip-check">{{ selectedMcpCatalogIds.includes(entry.id) ? '✓' : '' }}</span>
                  <span class="chip-mono">{{ entry.id }}</span>
                  <span class="chip-mcp-name">{{ entry.name }}</span>
                </label>
              </div>
            </div>
          </section>

          <section v-show="activeSection === 'outcomes'" class="section">
            <span class="field-hint">
              Asignaciones de campos (<code>$set:</code>) y operaciones de labels
              (<code>$labels:</code>) que este agente aplica al issue al arrancar,
              terminar OK o fallar.
            </span>
            <OutcomesEditor
              v-model="outcomes"
              :project-fields="outcomesProjectFields"
              :status-options="outcomesStatusOptions"
            />
          </section>

          <section v-show="activeSection === 'avanzado'" class="section">
            <div class="field">
              <span class="label">Necesita branch git</span>
              <span class="field-hint">
                Controla si el engine auto-crea (y linkea al issue) una branch
                cuando esta agente arranca sin <code>task.branch</code>. Por default,
                se deriva del set de tools (agentes con
                <code>fs_write</code>/<code>fs_edit</code>/<code>bash_run</code>
                la necesitan). Marcá <b>Sí</b> para agentes que commitean vía GitHub MCP
                sin tener write tools locales; <b>No</b> para desactivarlo aunque tenga write tools.
              </span>
              <div class="tri-toggle">
                <label>
                  <input type="radio" :checked="requiresBranch === null" @change="requiresBranch = null" />
                  Auto (derivar del set de tools)
                  <span class="derived-badge" :class="{ 'derived-badge--off': !derivedRequiresBranch }">
                    → {{ derivedRequiresBranch ? 'sí' : 'no' }} — {{ derivedRequiresBranchReason }}
                  </span>
                </label>
                <label>
                  <input type="radio" :checked="requiresBranch === true" @change="requiresBranch = true" />
                  Sí, siempre
                </label>
                <label>
                  <input type="radio" :checked="requiresBranch === false" @change="requiresBranch = false" />
                  No, nunca
                </label>
              </div>
            </div>
          </section>

          <div v-if="errors.length" class="error-list">
            <p v-for="e in errors" :key="e">{{ e }}</p>
          </div>

        </div>

        <!-- ── Resumen en lenguaje llano — verificar de un vistazo que el
             agente hace lo que uno cree, sin reconstruirlo campo por campo. ── -->
        <aside class="summary-rail">
          <div class="summary-card">
            <h4>Cómo se comporta</h4>
            <p class="summary-sentence">
              Disponible para <b>{{ scopeLabel }}</b>. Lo dispara una <b>regla</b>, no su propia
              configuración — ver la sección Reglas.
              <span v-if="allowBlocked"> Puede tomar tareas <b>bloqueadas</b>.</span>
              Usa <b>{{ providerDisplayName }}</b><span v-if="providerConfigDraft.model"> con <b>{{ providerConfigDraft.model }}</b></span><span v-if="providerConfigDraft.effort"> effort <b>{{ providerConfigDraft.effort }}</b></span>.
              <span v-if="outcomes.exits?.success"> Al terminar bien: <code>{{ outcomes.exits.success }}</code>.</span>
              <span v-if="outcomes.exits?.error"> Si falla: <code>{{ outcomes.exits.error }}</code>.</span>
              <span v-if="selectableExitNames.length"> El agente puede elegir: <code>{{ selectableExitNames.join(', ') }}</code>.</span>
            </p>
            <div class="check-list">
              <div v-for="c in checklist" :key="c.label" class="check-item" :class="c.ok ? 'check-item--ok' : 'check-item--warn'">
                <span class="check-ico">{{ c.ok ? '✓' : '!' }}</span>
                {{ c.label }}
              </div>
            </div>
          </div>
        </aside>

      </div>

    </div>
  </div>
</template>

<style scoped>
/* Ya no es un overlay fixed — el editor reemplaza la lista dentro del
   <main> de AppShell, así el sidebar (OVERVIEW/PROYECTOS/GLOBAL) queda
   siempre visible. El nombre de la clase quedó del diseño anterior. */
.overlay {
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
}

.page {
  flex: 1;
  min-height: 70vh;
  display: flex;
  flex-direction: column;
}

.page-head {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 0.75rem 1.25rem;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.page-head h3 { margin: 0; font-size: 1rem; font-weight: 700; color: var(--fg); font-family: var(--font-display); }
.page-head-spacer { flex: 1; }

.back-btn {
  background: none;
  border: none;
  font-size: 1.1rem;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0.25rem;
  line-height: 1;
}
.back-btn:hover { color: var(--fg-mute); }

.enabled-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.6rem;
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  border: 1px solid transparent;
}
.enabled-pill::before { content: '●'; font-size: 0.6rem; }
.enabled-pill--on { background: var(--green-bg); color: var(--accent); border-color: var(--accent); }
.enabled-pill--off { background: var(--panel-hi); color: var(--fg-dim); border-color: var(--border-hi); }
.enabled-pill:disabled { cursor: not-allowed; opacity: 0.75; }

.page-shell {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 240px 1fr 300px;
  overflow: hidden;
}

/* ── Rail de secciones ─────────────────────────────────────────────── */
.rail {
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 0.75rem 0.6rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.rail-item {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.55rem 0.6rem;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  cursor: pointer;
  text-align: left;
}
.rail-item:hover { background: var(--panel-alt); }
.rail-item--active { background: var(--panel-alt); border-color: var(--border-hi); }
.rail-head { display: flex; align-items: center; gap: 0.45rem; }
.rail-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.rail-dot--good { background: var(--accent); }
.rail-dot--neutral { background: var(--fg-dim); }
.rail-dot--danger { background: var(--danger); }
.rail-title { font-weight: 600; font-size: 0.85rem; color: var(--fg-mute); }
.rail-item--active .rail-title { color: var(--fg); }
.rail-sub {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--fg-dim);
  padding-left: 0.85rem;
  line-height: 1.35;
}

/* ── Panel principal ────────────────────────────────────────────────── */
.page-main {
  min-width: 0;
  overflow-y: auto;
  padding: 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}
.section { display: flex; flex-direction: column; gap: 1.1rem; }

/* ── Resumen ────────────────────────────────────────────────────────── */
.summary-rail {
  border-left: 1px solid var(--border);
  background: var(--panel);
  padding: 1rem;
  overflow-y: auto;
}
.summary-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.9rem;
}
.summary-card h4 {
  margin: 0 0 0.55rem;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
}
.summary-sentence { margin: 0; font-size: 0.85rem; line-height: 1.6; color: var(--fg-mute); }
.summary-sentence b { color: var(--fg); font-weight: 600; }
.summary-sentence code { font-family: var(--font-mono); font-size: 0.82em; color: var(--accent); background: none; padding: 0; }
.check-list { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.8rem; }
.check-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--fg-mute); }
.check-ico {
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.62rem;
  flex-shrink: 0;
}
.check-item--ok .check-ico { background: var(--green-bg); color: var(--accent); }
.check-item--warn .check-ico { background: var(--yellow-bg); color: var(--warn); }

/* ── Fields ─────────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.label { font-size: 0.82rem; font-weight: 600; color: var(--fg-mute); }
.field-hint { font-size: 0.73rem; color: var(--fg-dim); line-height: 1.4; }

.input {
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border-hi);
  font-size: 0.875rem;
  color: var(--fg);
  background: var(--panel);
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: var(--accent); }
.input:disabled { background: var(--panel-alt); color: var(--fg-dim); cursor: not-allowed; }
.select { cursor: pointer; }

/* ── Chips ──────────────────────────────────────────────────────────── */
.chip-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; }
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
}
.chip:hover { border-color: var(--info); color: var(--info); }
.chip.active { border-color: var(--info); background: var(--panel-hi); color: var(--info); font-weight: 500; }
.chip-check { width: 0.8rem; font-size: 0.72rem; color: var(--info); }
.chip-mono { font-family: var(--font-mono); }
.chip-mcp-name { color: var(--fg-dim); font-size: 0.72rem; }
.field-hint code { background: var(--panel-hi); padding: 0.1rem 0.3rem; font-size: 0.7rem; }
.tri-toggle { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; }
.tri-toggle label { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; cursor: pointer; }
.tri-toggle input[type='radio'] { accent-color: var(--info); }
.derived-badge {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  padding: 0.1rem 0.4rem;
  background: var(--green-bg);
  color: var(--accent);
  border-radius: var(--radius-sm);
}
.derived-badge--off {
  background: var(--panel-hi);
  color: var(--fg-dim);
}

/* ── Form-level AI bar ──────────────────────────────────────────────── */

/* ── Provider config (per-agent) ────────────────────────────────────── */
.pc-field :deep(.model-select) {
  padding: 0.45rem 0.65rem;
  font-size: 0.875rem;
  width: 100%;
  flex: none;
}

/* ── Errors ─────────────────────────────────────────────────────────── */
.error-list {
  background: var(--red-bg);
  border: 1px solid var(--danger);
  padding: 0.5rem 0.75rem;
}
.error-list p { margin: 0.15rem 0; font-size: 0.8rem; color: var(--danger); }

.readonly-banner {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--warn);
  border-radius: 6px;
  background: var(--yellow-bg);
  color: var(--warn);
  font-size: 0.8rem;
}

/* ── Mobile ─────────────────────────────────────────────────────────── */
@media (max-width: 900px) {
  /* El editor era una grilla de tres columnas con dos de ellas fijas
     (240 + 1fr + 300): sus mínimos suman 540px, así que en 390px el panel
     del medio —el único donde se edita algo— quedaba en cero y el
     `overflow: hidden` recortaba el resto. Se apila en una sola columna. */
  .page-shell {
    grid-template-columns: 1fr;
    overflow: visible;
  }
  /* `min-height: 70vh` sólo servía para que las tres columnas tuvieran alto
     contra el cual scrollear; apilado deja un hueco vacío bajo el resumen. */
  .page { min-height: 0; }

  /* Cada panel traía su propio `overflow-y: auto`. Apilados eso son tres
     scrolls anidados dentro del de la página: en touch no hay forma de saber
     cuál se está moviendo. Scrollea la página y nada más. */
  .rail,
  .page-main,
  .summary-rail { overflow: visible; }

  /* El rail deja de ser columna y pasa a ser una tira de pestañas que se
     desliza. El subtítulo se cae: es lo que hace que cada ítem mida 240px,
     y el título ya nombra la sección. */
  .rail {
    flex-direction: row;
    gap: 0.35rem;
    padding: 0.5rem;
    border-right: none;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .rail-item { flex: 0 0 auto; }
  .rail-sub { display: none; }

  .page-main { padding: 1rem 0.85rem; }

  .summary-rail {
    border-left: none;
    border-top: 1px solid var(--border);
  }
}

@media (max-width: 640px) {
  /* Back + título + Cancelar + Guardar no entran en una línea de 390px, y
     el head es un flex sin `wrap`: los dos botones se comían el título. El
     spacer —que ya existía para empujarlos a la derecha— pasa a ser el
     salto de línea, y abajo los botones se reparten el ancho (que además es
     el tamaño de toque que corresponde a la acción principal). */
  .page-head {
    flex-wrap: wrap;
    gap: 0.5rem 0.6rem;
    padding: 0.6rem 0.75rem;
  }
  .page-head h3 {
    flex: 1 1 0;
    min-width: 0;
    font-size: 0.95rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .page-head-spacer { flex: 0 0 100%; height: 0; }
  .page-head .btn { flex: 1 1 0; }
}
</style>
