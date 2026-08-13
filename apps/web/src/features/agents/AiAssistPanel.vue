<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProjectsStore } from '@/features/projects/store';
import { getTools, type ToolDefinition } from '@/features/tools/api';
import type { SystemPromptDef } from '@ia-flow/shared';

const props = defineProps<{
  currentPrompt: string;
  agentId?: string;
  agentVariables?: Array<{ key: string; value: string }>;
  agentSystemPromptIds?: string[];
  hasProposal?: boolean;
  templateContext?: 'system-prompt' | 'agent-prompt' | 'phase-prompt';
  // Parent-provided sysprompt list — same pattern as AgentEditorModal so the
  // panel doesn't need to know whether it's rendered under a global or a
  // project scope. Falls back to projectConfigStore for legacy callers.
  availableSystemPrompts?: SystemPromptDef[];
  // When true, the "description" (instructions) textarea can be empty in
  // generate mode — the caller supplies context another way.
  descriptionOptional?: boolean;
  // Sent as `description` when the textarea is empty. Useful when the
  // parent already knows the context (e.g. serialized form fields).
  descriptionFallback?: string;
  // Sysprompt ids to pre-select in the chips (i.e. they become part of
  // `system:` for the assist call). The user can still toggle.
  defaultSystemPromptIds?: string[];
  // Tool names to pre-select in the tool chips. When any tool is selected
  // (default or by user) the server takes the tool-aware path (anthropic
  // provider + executeLoop).
  defaultTools?: string[];
  // Repo contexts to attach to the tool call (so fs tools can resolve
  // "<repo-name>/relative/path" against a real filesystem path).
  repoContexts?: Array<{ name: string; path: string }>;
  // Hide the tool chips section entirely (useful when the caller wants
  // to force a tool set without letting the user edit it).
  hideToolChips?: boolean;
  // When present, switches to "form-fill" mode: the server forces a single
  // fill_form tool_use whose input_schema is this JSON Schema. The panel
  // emits `result-fields` with the returned object instead of `result`.
  // The form using the panel owns the schema — usually built from its
  // local Zod via `zod-to-json-schema` or hand-written.
  responseSchema?: Record<string, unknown>;
}>();

const emit = defineEmits<{
  result: [prompt: string, mode: 'generate' | 'refine'];
  'result-fields': [fields: Record<string, unknown>, mode: 'generate' | 'refine'];
}>();

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

const projectConfigStore = useProjectConfigStore();
const projectsStore = useProjectsStore();

const description        = ref('');
const selectedSysprompts = ref<string[]>([...(props.defaultSystemPromptIds ?? [])]);
const selectedTools      = ref<string[]>([...(props.defaultTools ?? [])]);
const availableTools     = ref<ToolDefinition[]>([]);
const loading            = ref(false);
const error              = ref('');

async function loadTools() {
  try {
    availableTools.value = await getTools();
  } catch {
    availableTools.value = [];
  }
}

function toggleTool(name: string) {
  const idx = selectedTools.value.indexOf(name);
  if (idx === -1) selectedTools.value.push(name);
  else selectedTools.value.splice(idx, 1);
}

const availableSysprompts = computed<SystemPromptDef[]>(
  () => props.availableSystemPrompts ?? projectConfigStore.config?.systemPrompts ?? [],
);

// Always keep the first available sysprompt selected by default. Re-runs when
// the list arrives (config loads async) and once at mount. We only *add* it
// if missing — we never remove what the user or the caller preset.
const firstSyspromptSeeded = ref(false);
watch(
  availableSysprompts,
  (list) => {
    if (firstSyspromptSeeded.value) return;
    if (!list.length) return;
    const firstId = list[0].id;
    if (!selectedSysprompts.value.includes(firstId)) {
      selectedSysprompts.value = [firstId, ...selectedSysprompts.value];
    }
    firstSyspromptSeeded.value = true;
  },
  { immediate: true },
);

const mode = computed(() => props.currentPrompt.trim() ? 'refine' : 'generate');
const isFormFill = computed(() => !!props.responseSchema);
const btnLabel = computed(() => {
  if (loading.value) {
    if (isFormFill.value) return '⏳ Sugiriendo…';
    if (props.hasProposal) return '⏳ Iterando…';
    return mode.value === 'refine' ? '⏳ Mejorando…' : '⏳ Generando…';
  }
  if (isFormFill.value) return '✨ Sugerir campos';
  if (props.hasProposal) return '↻ Iterar sobre propuesta';
  return mode.value === 'refine' ? '✦ Mejorar prompt' : '⚡ Generar prompt';
});
const placeholder = computed(() => {
  if (isFormFill.value) return 'Describe qué quieres prellenar (opcional si ya hay contexto)…';
  if (props.hasProposal) return 'Instrucciones para iterar sobre la propuesta actual…';
  return mode.value === 'refine'
    ? 'Instrucciones para mejorar el prompt…'
    : 'Describe qué debe hacer este agente…';
});

onMounted(async () => {
  if (!projectConfigStore.config) {
    await projectConfigStore.fetch();
  }
  if (!props.hideToolChips) void loadTools();
});

function toggleSysprompt(id: string) {
  const idx = selectedSysprompts.value.indexOf(id);
  if (idx === -1) selectedSysprompts.value.push(id);
  else selectedSysprompts.value.splice(idx, 1);
}

async function run() {
  const trimmed = description.value.trim();
  if (mode.value === 'generate' && !trimmed && !props.descriptionOptional) {
    error.value = 'Escribe una descripción primero.';
    return;
  }
  error.value = '';
  loading.value = true;
  const effectiveDescription = trimmed || props.descriptionFallback || '';
  const payload = {
    mode: mode.value,
    agentId: props.agentId || undefined,
    description: effectiveDescription || undefined,
    currentPrompt: props.currentPrompt || undefined,
    tools: selectedTools.value.length ? selectedTools.value : undefined,
    repoContexts: props.repoContexts?.length ? props.repoContexts : undefined,
    systemPromptIds: selectedSysprompts.value.length ? selectedSysprompts.value : undefined,
    agentVariables: props.agentVariables?.length ? props.agentVariables : undefined,
    agentSystemPromptIds: props.agentSystemPromptIds?.length ? props.agentSystemPromptIds : undefined,
    templateContext: props.templateContext,
    projectId: projectsStore.activeProjectId ?? undefined,
    responseSchema: props.responseSchema,
  };
  const t0 = performance.now();
  console.groupCollapsed(`[AiAssist] ${payload.mode} → agent=${payload.agentId ?? 'unknown'}`);
  console.log('request payload', payload);
  try {
    const res = await fetch(`${API_BASE}/api/agents/assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data: { prompt?: string; fields?: Record<string, unknown>; error?: string } = {};
    try {
      data = JSON.parse(text);
    } catch {
      error.value = `Respuesta inesperada: ${text.slice(0, 120)}`;
      console.error('non-JSON response', text);
      return;
    }
    if (!res.ok || data.error) {
      error.value = data.error ?? 'Error desconocido';
      console.error(`assist failed (${res.status})`, data.error);
      return;
    }
    if (props.responseSchema && data.fields) {
      console.log(`assist done in ${Math.round(performance.now() - t0)}ms — fieldKeys=${Object.keys(data.fields).join(',')}`);
      emit('result-fields', data.fields, mode.value);
    } else {
      console.log(`assist done in ${Math.round(performance.now() - t0)}ms — outputLen=${data.prompt?.length ?? 0}`);
      emit('result', data.prompt ?? '', mode.value);
    }
    description.value = '';
  } catch (e) {
    error.value = `Error de conexión: ${e instanceof Error ? e.message : String(e)}`;
    console.error('assist network error', e);
  } finally {
    console.groupEnd();
    loading.value = false;
  }
}
</script>

<template>
  <div class="ai-panel">
    <p class="ai-panel-title">Asistente IA</p>

    <div v-if="availableSysprompts.length" class="ai-sp-chips">
      <label
        v-for="sp in availableSysprompts"
        :key="sp.id"
        class="ai-sp-chip"
        :class="{ active: selectedSysprompts.includes(sp.id) }"
        :title="sp.text"
        @click="toggleSysprompt(sp.id)"
      >
        <span class="ai-sp-check">{{ selectedSysprompts.includes(sp.id) ? '✓' : '' }}</span>
        <span class="ai-sp-name">{{ sp.name }}</span>
      </label>
    </div>

    <div v-if="!hideToolChips && availableTools.length" class="ai-tool-chips">
      <span class="ai-tool-label">Tools:</span>
      <label
        v-for="tool in availableTools"
        :key="tool.name"
        class="ai-tool-chip"
        :class="{ active: selectedTools.includes(tool.name) }"
        :title="tool.description"
        @click="toggleTool(tool.name)"
      >
        <span class="ai-tool-check">{{ selectedTools.includes(tool.name) ? '✓' : '' }}</span>
        <span class="ai-tool-name">{{ tool.name }}</span>
      </label>
    </div>

    <textarea
      v-model="description"
      class="ai-textarea"
      :placeholder="placeholder"
      rows="3"
      :disabled="loading"
    />
    <p v-if="error" class="ai-error">{{ error }}</p>
    <button class="btn-ai-action" :disabled="loading" @click="run">
      {{ btnLabel }}
    </button>
  </div>
</template>

<style scoped>
.ai-panel {
  background: var(--panel-hi);
  border: 1px solid var(--panel-hi);
  border-radius: 8px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.ai-panel-title {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--magenta);
}

.ai-sp-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.ai-sp-chip {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--panel-hi);
  border-radius: 5px;
  font-size: 0.73rem;
  color: var(--fg-dim);
  cursor: pointer;
  user-select: none;
  background: var(--panel);
  transition: border-color 0.1s, background 0.1s, color 0.1s;
}
.ai-sp-chip:hover { border-color: var(--magenta); color: var(--magenta); }
.ai-sp-chip.active { border-color: var(--magenta); background: var(--panel-hi); color: var(--magenta); font-weight: 500; }

.ai-sp-check { width: 0.75rem; font-size: 0.68rem; color: var(--magenta); }
.ai-sp-name { font-family: 'SF Mono', 'Fira Code', monospace; }

.ai-tool-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
}
.ai-tool-label {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--info);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.ai-tool-chip {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--info);
  border-radius: 5px;
  font-size: 0.72rem;
  color: var(--fg-dim);
  cursor: pointer;
  user-select: none;
  background: var(--panel);
  transition: border-color 0.1s, background 0.1s, color 0.1s;
}
.ai-tool-chip:hover { border-color: var(--info); color: var(--info); }
.ai-tool-chip.active { border-color: var(--info); background: var(--panel-hi); color: var(--info); font-weight: 500; }
.ai-tool-check { width: 0.7rem; font-size: 0.65rem; color: var(--info); }
.ai-tool-name { font-family: 'SF Mono', 'Fira Code', monospace; }

.ai-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--panel-hi);
  border-radius: 6px;
  font-size: 0.84rem;
  font-family: inherit;
  color: var(--fg);
  background: var(--panel);
  resize: vertical;
  outline: none;
  line-height: 1.5;
}
.ai-textarea:focus { border-color: var(--magenta); box-shadow: 0 0 0 3px rgba(167,139,250,0.15); }
.ai-textarea:disabled { opacity: 0.6; cursor: not-allowed; }

.ai-error {
  margin: 0;
  font-size: 0.78rem;
  color: var(--danger);
}

.btn-ai-action {
  align-self: flex-start;
  padding: 0.35rem 0.85rem;
  border: 1px solid var(--magenta);
  border-radius: 6px;
  background: var(--magenta);
  color: var(--panel);
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-ai-action:hover:not(:disabled) { background: var(--ai); }
.btn-ai-action:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
