<script setup lang="ts">
import { fetchMcpCatalog, fetchToolCatalog } from '@/features/agents/api';
import { ref, computed, watch } from 'vue';
import AgentDefinitionSection from '@/features/agents/AgentDefinitionSection.vue';
import SystemPromptsSection from '@/features/agents/SystemPromptsSection.vue';
import AgentPromptSection from '@/features/agents/AgentPromptSection.vue';
import AgentRunSection from '@/features/agents/AgentRunSection.vue';
import OutcomesEditor from '@/features/agents/OutcomesEditor.vue';
import OutputContractEditor from '@/features/agents/OutputContractEditor.vue';
import CollapsibleSection from '@/ui/CollapsibleSection.vue';
import FormFooter from '@/ui/FormFooter.vue';
import { useIsSplit } from '@/composables/useIsMobile';
import type { KV } from '@/features/prompts/PromptField.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProvidersStore } from '@/features/providers/store';
import { useProjectsStore } from '@/features/projects/store';
import type { AgentDefinition, AgentOutcomes, AgentOutput, AgentProviderChoice, AgentToolEntry, McpCatalogEntry, SystemPromptDef, SystemPromptRef, WhenCondition } from '@ia-flow/shared';
import { validateAnthropicApiSettings } from '@ia-flow/shared';
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
// (la única forma que funciona en un deploy YAML headless — ver
// SystemPromptsSection) mezcladas con ids de catálogo. Tipado angosto a
// `{text}` porque acá sólo viven las no-string (ver el filter de abajo y
// SystemPromptsSection, que las edita como bloques de texto suelto).
const preservedSystemPromptRefs = ref<Exclude<SystemPromptRef, string>[]>([]);
// Puesta por el AI-assist form-fill de AgentDefinitionSection (vía
// `propose-prompt`) cuando ya había un prompt distinto — AgentPromptSection
// la muestra como diff, no la pisa (ver PromptField `pending-proposal`).
const pendingPromptProposal = ref<string | null>(null);
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
// Comandos de `AgentDefinition.verify` — un patrón por línea, mismo estilo
// que el allow/deny de bash_run en ToolsEditor. Se commitea a `verify` recién
// en onSave (via linesFrom), no en cada tecla.
const verifyDraft = ref('');

// ─── Outcomes (see AgentOutcomesSchema) — $set:/$labels: strings per slot
const outcomes = ref<AgentOutcomes>({});
// `AgentDefinition.output` — contrato de salida estructurada. Vive aparte de
// `outcomes` porque no es una transición: es lo que este agente ENTREGA.
const outputContract = ref<AgentOutput | undefined>(undefined);

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

// "Definición" es la franja de identidad y nada más: ni el prompt (sección
// propia) ni el provider (se fue a "Cómo corre"). Su resumen es el id, que es
// lo único que identifica al agente.
const definitionSummary = computed(() => agentId.value.trim() || 'sin id');

const systemPromptsSummary = computed(() => {
  const parts: string[] = [];
  if (selectedSysprompts.value.length) parts.push(`${selectedSysprompts.value.length} del catálogo`);
  if (preservedSystemPromptRefs.value.length) parts.push(`${preservedSystemPromptRefs.value.length} inline`);
  return parts.length ? parts.join(' · ') : 'sin selección';
});

const promptSummary = computed(() => (prompt.value.trim() ? 'con contenido' : 'sin prompt'));

// El resumen de "Cómo corre" es lo que hace innecesario abrirla (R22): el
// valor efectivo —`anthropic-api · opus · 6 tools`— y no «configuración del
// provider».
const runSummary = computed(() => {
  const choices = providerChoices.value;
  const first =
    providers.value.find((x) => x.id === choices[0]?.providerId)?.name ??
    choices[0]?.providerId ??
    'sin provider';
  const parts: string[] = [choices.length > 1 ? `${first} +${choices.length - 1}` : first];
  const model = providerConfigDraft.value.model;
  if (typeof model === 'string' && model) parts.push(model);
  const t = (tools.value ?? []).length;
  if (t) parts.push(`${t} tool${t === 1 ? '' : 's'}`);
  const m = selectedMcpCatalogIds.value.length;
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
// negra que obliga a leer el hint para saber qué hace en este agente.
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

const verifyCommandCount = computed(() => linesFrom(verifyDraft.value).length);

const advancedSummary = computed(() => {
  const branch =
    requiresBranch.value === null
      ? `branch: auto → ${derivedRequiresBranch.value ? 'sí' : 'no'}`
      : requiresBranch.value
        ? 'branch: siempre'
        : 'branch: nunca';
  const verify = verifyCommandCount.value
    ? `verify: ${verifyCommandCount.value} comando${verifyCommandCount.value === 1 ? '' : 's'}`
    : null;
  return [branch, verify].filter(Boolean).join(' · ');
});

// ─── Las franjas del formulario (R19) ─────────────────────────────────────
//
// El MISMO orden y las MISMAS seis entradas en los dos regímenes de ancho; lo
// único que cambia es dónde vive el índice (R24). Sobre --bp-split es el rail
// al costado y se ve una franja por vez; abajo, cada franja es un
// `CollapsibleSection` con el mismo título y el mismo resumen que el rail — el
// chevron y el rail son dos presentaciones del mismo índice, así que la lista
// que ofrecen tiene que ser la misma. Antes, abajo de ese ancho, el rail se
// volvía una tira horizontal de pestañas con scroll lateral: un índice
// haciendo de tab (R2, R14).
//
// `defaultOpen` es lo que un formulario recién abierto muestra: lo obligatorio
// —el id y el prompt— nunca detrás de un chevron (R20). El provider también es
// obligatorio pero nace con un valor, así que se puede guardar sin abrir «Cómo
// corre»; si igual quedara inválido, `validate` la abre sola.
//
// «Cuándo aplica» no existe para un agente: la activación se fue a `rules`
// (migración 059). Una franja vacía no se dibuja.
//
// Cada entrada resuelve su propio "¿hay algo que atender acá?" para el punto
// de estado, y su `summary` es el VALOR efectivo, no una descripción (R22).

type SectionKey = 'definicion' | 'systemprompts' | 'prompt' | 'outcomes' | 'comocorre' | 'avanzado';
type SectionDot = 'good' | 'neutral' | 'danger';

const activeSection = ref<SectionKey>('definicion');

const sections = computed<
  { key: SectionKey; title: string; summary: string; dot: SectionDot; defaultOpen: boolean }[]
>(() => [
  // Franja 1 · qué es
  {
    key: 'definicion',
    title: 'Definición',
    summary: definitionSummary.value,
    dot: agentId.value.trim() ? 'good' : 'danger',
    defaultOpen: true,
  },
  // Franja 2 · qué hace
  {
    key: 'systemprompts',
    title: 'System Prompts',
    summary: systemPromptsSummary.value,
    dot: (selectedSysprompts.value.length || preservedSystemPromptRefs.value.length) ? 'good' : 'neutral',
    defaultOpen: false,
  },
  {
    key: 'prompt',
    title: 'Prompt',
    summary: promptSummary.value,
    dot: prompt.value.trim() ? 'good' : 'danger',
    defaultOpen: true,
  },
  {
    key: 'outcomes',
    title: 'Outcomes',
    summary: outcomesSummary.value,
    dot: (outcomes.value.onProcess || Object.keys(outcomes.value.exits ?? {}).length) ? 'good' : 'neutral',
    defaultOpen: false,
  },
  // Franja 4 · cómo corre
  {
    key: 'comocorre',
    title: 'Cómo corre',
    summary: runSummary.value,
    dot: providerChoices.value.length ? 'good' : 'danger',
    defaultOpen: false,
  },
  // Franja 5 · crudo
  {
    key: 'avanzado',
    title: 'Avanzado',
    summary: advancedSummary.value,
    dot: 'neutral',
    defaultOpen: false,
  },
]);

const sectionByKey = computed(() => new Map(sections.value.map((s) => [s.key, s])));

const { isSplit } = useIsSplit();

// Sobre --bp-split una franja es una `<section>` pelada: el índice ya está al
// costado y sólo se dibuja la activa, así que un encabezado propio sería la
// identidad dos veces (R9). Abajo, el encabezado del `CollapsibleSection` ES
// el índice de ese régimen.
const bandTag = computed(() => (isSplit.value ? 'section' : CollapsibleSection));
function bandAttrs(key: SectionKey): Record<string, unknown> {
  if (isSplit.value) return { class: 'section' };
  const s = sectionByKey.value.get(key);
  return { title: s?.title, summary: s?.summary, defaultOpen: s?.defaultOpen };
}
function bandShown(key: SectionKey) {
  return isSplit.value ? activeSection.value === key : true;
}

// Para abrir la franja plegada donde cayó el primer error de validación —
// `CollapsibleSection` expone `forceOpen` justo para esto.
const bandRefs: Partial<Record<SectionKey, { forceOpen?: () => void } | null>> = {};
function setBandRef(key: SectionKey, el: unknown) {
  bandRefs[key] = el as { forceOpen?: () => void } | null;
}

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

// Bajo --bp-split no hay tercera columna donde poner la checklist, y un
// `Guardar` deshabilitado no dice por qué: lo que falta baja al pie, que es
// exactamente lo que ese panel dice. Se nombra UNA cosa — la primera — porque
// una alerta que crece con la cantidad de problemas tapa el que hay que
// arreglar (R15).
const footerNote = computed(() => checklist.value.find((c) => !c.ok)?.label);

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
  pendingPromptProposal.value = null;
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
    preservedSystemPromptRefs.value = (a.systemPrompts ?? []).filter(
      (r): r is Exclude<SystemPromptRef, string> => typeof r !== 'string',
    );
    providerConfigDraft.value = { ...(a.providerConfig ?? {}) };
    selectedMcpCatalogIds.value = [...(a.mcpCatalogIds ?? [])];
    requiresBranch.value = a.requiresBranch ?? null;
    allowBlocked.value = a.allowBlocked ?? false;
    maxConcurrentDispatches.value = a.maxConcurrentDispatches ?? null;
    verifyDraft.value = (a.verify ?? []).join('\n');
    outcomes.value = { onProcess: a.onProcess, exits: a.exits };
    outputContract.value = a.output;
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
    verifyDraft.value = '';
    outcomes.value = {};
    outputContract.value = undefined;
  }

  if (!availableTools.value.length) {
    try {
      // Acotado al ámbito del editor: un agente de proyecto ve las globales
      // más las definidas por SU proyecto, y uno global sólo las globales.
      // Sin esto el picker ofrecía las tools definidas de otro proyecto — el
      // agente las puede nombrar, pero su acción no le pertenece.
      const q = props.scope === 'project' && projectsStore.activeProjectId
        ? `?projectId=${encodeURIComponent(projectsStore.activeProjectId)}`
        : '?scope=global';
      availableTools.value = await fetchToolCatalog(q);
    } catch { /* server may not be running */ }
  }

  try {
    availableMcpCatalog.value = await fetchMcpCatalog();
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

// ─── Validation & save ────────────────────────────────────────────────────────

function kvToRecord(list: KV[]): Record<string, string> {
  return Object.fromEntries(list.filter(kv => kv.key).map(kv => [kv.key, kv.value]));
}

function validate(): boolean {
  errors.value = [];
  let firstErrorSection: SectionKey | null = null;
  if (!agentId.value.trim()) {
    errors.value.push('El id es requerido.');
    firstErrorSection ??= 'definicion';
  }
  if (/\s/.test(agentId.value)) {
    errors.value.push('El id no puede tener espacios.');
    firstErrorSection ??= 'definicion';
  }
  if (!providerChoices.value.length || providerChoices.value.some((c) => !c.providerId.trim())) {
    errors.value.push('El provider es requerido — tildá al menos uno.');
    firstErrorSection ??= 'comocorre';
  }
  if (!prompt.value.trim()) {
    errors.value.push('El prompt es requerido.');
    firstErrorSection ??= 'prompt';
  }
  if (providerChoices.value.some((c) => c.providerId === 'anthropic-api')) {
    const pc = providerConfigDraft.value;
    const anthropicError = validateAnthropicApiSettings({
      model: (pc.model as string | undefined) ?? providersStore.config?.anthropicApi.model,
      effort: pc.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
      taskBudgetTokens: pc.taskBudgetTokens as number | undefined,
    });
    if (anthropicError) {
      errors.value.push(anthropicError);
      firstErrorSection ??= 'comocorre';
    }
  }
  // Salta a la franja donde vive el primer error — si no, el usuario ve la
  // lista de errores sin saber dónde resolverlos. Sobre --bp-split eso es
  // seleccionar en el rail; abajo, abrir la franja si estaba plegada (lo
  // obligatorio nunca se esconde, R20, pero el provider ya elegido puede
  // quedar inválido por un `model` que no existe).
  if (firstErrorSection) {
    activeSection.value = firstErrorSection;
    bandRefs[firstErrorSection]?.forceOpen?.();
  }
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
  // Los ids del catálogo (los que sí administra este editor) van primero,
  // seguidos de las entradas {text} preservadas (no editables acá) — no
  // reconstruye el orden original si venían intercaladas, pero no pierde
  // ninguna.
  const systemPromptRefs: SystemPromptRef[] = [
    ...selectedSysprompts.value,
    ...preservedSystemPromptRefs.value,
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
  const verifyCommands = linesFrom(verifyDraft.value);
  if (verifyCommands.length) agent.verify = verifyCommands;
  Object.assign(agent, outcomes.value);
  if (outputContract.value) agent.output = outputContract.value;
  emit('save', agent);
}

function linesFrom(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function buildProviderConfig(): Record<string, unknown> | undefined {
  const draft = providerConfigDraft.value;
  return draft && Object.keys(draft).length > 0 ? { ...draft } : undefined;
}

</script>

<template>
  <div v-if="open" class="overlay">
    <div class="page">

      <!-- La cabecera identifica y nada más: los botones se fueron al pie
           (`FormFooter`), que es donde termina el formulario y donde el pulgar
           los busca sin tener que volver arriba (R3). -->
      <div class="page-head">
        <button class="back-btn" aria-label="Cerrar" @click="emit('close')">←</button>
        <h3>{{ title }}</h3>
      </div>

      <p v-if="readonly" class="readonly-banner">
        Solo lectura — este agente no se puede guardar desde acá.
      </p>

      <div class="page-shell">

        <!-- ── El índice, sobre --bp-split: responde "¿qué hay acá?" sin
             entrar. Abajo de ese ancho no se monta — ahí el índice son los
             encabezados de las franjas plegadas (R24). ── -->
        <nav v-if="isSplit" class="rail">
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

        <!-- ── El formulario. Sobre --bp-split, una franja a la vez; abajo,
             todas en orden. `.ff-col` le pone el tope de 46rem (R25). ── -->
        <div class="page-main ff-col">

          <component
            :is="bandTag"
            v-bind="bandAttrs('definicion')"
            v-show="bandShown('definicion')"
            :ref="(el: unknown) => setBandRef('definicion', el)"
          >
            <AgentDefinitionSection
              :agent-id="agentId"
              :is-new="isNew"
              :provider-choices="providerChoices"
              :provider-config="providerConfigDraft"
              :prompt="prompt"
              :variables="variables"
              :agent-variable-groups="agentVariableGroups"
              :selected-sysprompts="selectedSysprompts"
              :available-sysprompts="availableSysprompts"
              :available-tools="availableTools"
              @update:agent-id="agentId = $event"
              @update:provider-config="providerConfigDraft = $event"
              @update:prompt="prompt = $event"
              @propose-prompt="pendingPromptProposal = $event"
              @update:variables="variables = $event"
              @update:selected-sysprompts="selectedSysprompts = $event"
              @apply-tools="applyToolNames"
            />
          </component>

          <component
            :is="bandTag"
            v-bind="bandAttrs('systemprompts')"
            v-show="bandShown('systemprompts')"
            :ref="(el: unknown) => setBandRef('systemprompts', el)"
          >
            <SystemPromptsSection
              :selected-sysprompts="selectedSysprompts"
              :available-sysprompts="availableSysprompts"
              :inline-prompts="preservedSystemPromptRefs.map((r) => r.text)"
              @update:selected-sysprompts="selectedSysprompts = $event"
              @update:inline-prompts="preservedSystemPromptRefs = $event.map((text) => ({ text }))"
            />
          </component>

          <component
            :is="bandTag"
            v-bind="bandAttrs('prompt')"
            v-show="bandShown('prompt')"
            :ref="(el: unknown) => setBandRef('prompt', el)"
          >
            <AgentPromptSection
              :prompt="prompt"
              :variables="variables"
              :agent-variable-groups="agentVariableGroups"
              :agent-id="agentId"
              :available-sysprompts="availableSysprompts"
              :pending-prompt-proposal="pendingPromptProposal"
              @update:prompt="prompt = $event"
              @update:variables="variables = $event"
              @clear-pending-proposal="pendingPromptProposal = null"
            />
          </component>

          <component
            :is="bandTag"
            v-bind="bandAttrs('outcomes')"
            v-show="bandShown('outcomes')"
            :ref="(el: unknown) => setBandRef('outcomes', el)"
          >
            <p class="ff-hint">
              Asignaciones de campos (<code>$set:</code>) y operaciones de labels
              (<code>$labels:</code>) que este agente aplica al issue al arrancar,
              terminar OK o fallar.
            </p>
            <OutcomesEditor
              v-model="outcomes"
              :project-fields="outcomesProjectFields"
              :status-options="outcomesStatusOptions"
            />

            <div class="ff-row">
              <span class="uc-label">Salida estructurada</span>
              <OutputContractEditor v-model="outputContract" />
            </div>
          </component>

          <component
            :is="bandTag"
            v-bind="bandAttrs('comocorre')"
            v-show="bandShown('comocorre')"
            :ref="(el: unknown) => setBandRef('comocorre', el)"
          >
            <AgentRunSection
              :provider-choices="providerChoices"
              :providers="providers"
              :provider-config="providerConfigDraft"
              :tools="tools"
              :mcp-catalog="availableMcpCatalog"
              :selected-mcp-catalog-ids="selectedMcpCatalogIds"
              @update:provider-choices="providerChoices = $event"
              @update:provider-config="providerConfigDraft = $event"
              @update:tools="tools = $event"
              @update:selected-mcp-catalog-ids="selectedMcpCatalogIds = $event"
            />
          </component>

          <component
            :is="bandTag"
            v-bind="bandAttrs('avanzado')"
            v-show="bandShown('avanzado')"
            :ref="(el: unknown) => setBandRef('avanzado', el)"
          >
            <div class="ff-row">
              <span class="uc-label">Necesita branch git</span>
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
              <p class="ff-hint">
                Decide si el engine auto-crea (y linkea al issue) una branch cuando el agente
                arranca sin <code>task.branch</code>. <b>Sí</b> para un agente que commitea vía
                GitHub MCP sin write tools locales; <b>No</b> para desactivarlo aunque las tenga.
              </p>
            </div>

            <div class="ff-row">
              <span class="uc-label">Verificación post-run</span>
              <textarea
                v-model="verifyDraft"
                class="ff-field ff-textarea ff-mono"
                rows="3"
                spellcheck="false"
                placeholder="bun run typecheck&#10;bun test"
              ></textarea>
              <p class="ff-hint">
                Un comando por línea, que el ENGINE corre en el worktree al terminar el agente
                (sólo en runs sync). Si alguno sale distinto de 0, el run cuenta como error
                (<code>failureClass: verify_failed</code>) y el issue no avanza.
              </p>
            </div>
          </component>

          <div v-if="errors.length" class="error-list">
            <p v-for="e in errors" :key="e">{{ e }}</p>
          </div>

        </div>

        <!-- ── Resumen en lenguaje llano — verificar de un vistazo que el
             agente hace lo que uno cree, sin reconstruirlo campo por campo.
             Es la tercera columna y sólo existe con ancho para tenerla: abajo
             de --bp-split, lo que la checklist decía va al pie. Nada de acá
             lleva un control que no exista en el formulario (R17). ── -->
        <aside v-if="isSplit" class="summary-rail">
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

      <FormFooter
        class="page-foot"
        :note="footerNote"
        note-is-error
        :save-disabled="saving"
        save-label="Guardar agente"
        :delete-label="!isNew && agent ? 'Eliminar…' : undefined"
        :readonly="readonly"
        @save="onSave"
        @cancel="emit('close')"
        @delete="agent && emit('delete', agent)"
      />

    </div>
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>

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
}
/* `.ff-col` ya trae el `display: flex` en columna, el `gap` y el tope de
   46rem; acá sólo se centra en el espacio que quede a la derecha del rail. */
.page-main.ff-col { margin-inline: auto; }
.section { display: flex; flex-direction: column; gap: 0.9rem; }

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

/* ── Fields ─────────────────────────────────────────────────────────────
   La caja, el label y el hint son del kit compartido (`ui/form-fields.css` +
   `.uc-label`, R18). Acá sólo queda lo que este editor tiene y nadie más. */
.tri-toggle { display: flex; flex-direction: column; gap: 0.3rem; font-size: var(--fs-body-sm); }
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

/* ── Errors ─────────────────────────────────────────────────────────── */
.error-list {
  background: var(--red-bg);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.75rem;
}
.error-list p { margin: 0.15rem 0; font-size: var(--fs-body-sm); color: var(--danger); }

.readonly-banner {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--warn);
  border-radius: var(--radius);
  background: var(--yellow-bg);
  color: var(--warn);
  font-size: var(--fs-body-sm);
}

/* ── Pie ────────────────────────────────────────────────────────────────
   Fuera de `.page-shell`, así queda al pie del editor entero y no adentro de
   una de las tres columnas. `StickyActionBar` decide solo si se pega (bajo
   --bp-shell) o si es un pie de diálogo (arriba). */
.page-foot {
  flex-shrink: 0;
  padding: 0.5rem 1.25rem;
  border-top: 1px solid var(--border);
  background: var(--panel);
}

/* ── Bajo --bp-split: se pierde la segunda columna ──────────────────── */
/* 1100 y no 900 (el valor original): a 900 con el sidebar abierto quedan
   ~670px de contenido, y tres columnas de 240 + 1fr + 300 no entran ahí
   tampoco. Es uno de los tres breakpoints del sistema — ver DESIGN_SYSTEM.md. */
@media (max-width: 1100px) {
  /* El rail y el resumen no se montan bajo este ancho (`v-if="isSplit"`), así
     que la grilla de tres columnas queda en una y el formulario ocupa todo.
     Antes el rail se volvía una tira horizontal de pestañas que se deslizaba:
     scroll lateral (R2) y un índice haciendo de tab (R14). Ahora el índice de
     este régimen son los encabezados de las franjas plegadas. */
  .page-shell {
    grid-template-columns: 1fr;
    overflow: visible;
  }
  /* `min-height: 70vh` sólo servía para que las tres columnas tuvieran alto
     contra el cual scrollear; en una columna deja un hueco vacío al pie. */
  .page { min-height: 0; }

  /* El panel traía su propio `overflow-y: auto`: en una sola columna eso es un
     scroll anidado dentro del de la página, y en touch no hay forma de saber
     cuál se está moviendo. Scrollea la página y nada más. */
  .page-main { overflow: visible; padding: 1rem 0.85rem; }
}

@media (max-width: 640px) {
  /* Los botones ya no están en la cabecera —se fueron al pie—, así que el
     título tiene la fila entera y sólo necesita no desbordarla. */
  .page-head { padding: 0.6rem 0.75rem; }
  .page-head h3 {
    flex: 1 1 0;
    min-width: 0;
    font-size: 0.95rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .page-foot { padding: 0.5rem 0.75rem; }
}
</style>
