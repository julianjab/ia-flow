<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProjectsStore } from '@/features/projects/store';
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
}>();

const emit = defineEmits<{
  result: [prompt: string, mode: 'generate' | 'refine'];
}>();

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

const projectConfigStore = useProjectConfigStore();
const projectsStore = useProjectsStore();

const description        = ref('');
const selectedSysprompts = ref<string[]>([]);
const loading            = ref(false);
const error              = ref('');

const availableSysprompts = computed<SystemPromptDef[]>(
  () => props.availableSystemPrompts ?? projectConfigStore.config?.systemPrompts ?? [],
);

const mode = computed(() => props.currentPrompt.trim() ? 'refine' : 'generate');
const btnLabel = computed(() => {
  if (loading.value) {
    if (props.hasProposal) return '⏳ Iterando…';
    return mode.value === 'refine' ? '⏳ Mejorando…' : '⏳ Generando…';
  }
  if (props.hasProposal) return '↻ Iterar sobre propuesta';
  return mode.value === 'refine' ? '✦ Mejorar prompt' : '⚡ Generar prompt';
});
const placeholder = computed(() => {
  if (props.hasProposal) return 'Instrucciones para iterar sobre la propuesta actual…';
  return mode.value === 'refine'
    ? 'Instrucciones para mejorar el prompt…'
    : 'Describe qué debe hacer este agente…';
});

onMounted(async () => {
  if (!projectConfigStore.config) {
    await projectConfigStore.fetch();
  }
});

function toggleSysprompt(id: string) {
  const idx = selectedSysprompts.value.indexOf(id);
  if (idx === -1) selectedSysprompts.value.push(id);
  else selectedSysprompts.value.splice(idx, 1);
}

async function run() {
  if (mode.value === 'generate' && !description.value.trim()) {
    error.value = 'Escribe una descripción primero.';
    return;
  }
  error.value = '';
  loading.value = true;
  const payload = {
    mode: mode.value,
    agentId: props.agentId || undefined,
    description: description.value || undefined,
    currentPrompt: props.currentPrompt || undefined,
    systemPromptIds: selectedSysprompts.value.length ? selectedSysprompts.value : undefined,
    agentVariables: props.agentVariables?.length ? props.agentVariables : undefined,
    agentSystemPromptIds: props.agentSystemPromptIds?.length ? props.agentSystemPromptIds : undefined,
    templateContext: props.templateContext,
    projectId: projectsStore.activeProjectId ?? undefined,
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
    let data: { prompt?: string; error?: string } = {};
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
    console.log(`assist done in ${Math.round(performance.now() - t0)}ms — outputLen=${data.prompt?.length ?? 0}`);
    emit('result', data.prompt ?? '', mode.value);
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
  background: #faf5ff;
  border: 1px solid #ddd6fe;
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
  color: #7c3aed;
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
  border: 1px solid #ddd6fe;
  border-radius: 5px;
  font-size: 0.73rem;
  color: #6b7280;
  cursor: pointer;
  user-select: none;
  background: #fff;
  transition: border-color 0.1s, background 0.1s, color 0.1s;
}
.ai-sp-chip:hover { border-color: #a78bfa; color: #7c3aed; }
.ai-sp-chip.active { border-color: #a78bfa; background: #f5f3ff; color: #7c3aed; font-weight: 500; }

.ai-sp-check { width: 0.75rem; font-size: 0.68rem; color: #7c3aed; }
.ai-sp-name { font-family: 'SF Mono', 'Fira Code', monospace; }

.ai-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 0.45rem 0.65rem;
  border: 1px solid #ddd6fe;
  border-radius: 6px;
  font-size: 0.84rem;
  font-family: inherit;
  color: #1e293b;
  background: #fff;
  resize: vertical;
  outline: none;
  line-height: 1.5;
}
.ai-textarea:focus { border-color: #a78bfa; box-shadow: 0 0 0 3px rgba(167,139,250,0.15); }
.ai-textarea:disabled { opacity: 0.6; cursor: not-allowed; }

.ai-error {
  margin: 0;
  font-size: 0.78rem;
  color: #dc2626;
}

.btn-ai-action {
  align-self: flex-start;
  padding: 0.35rem 0.85rem;
  border: 1px solid #a78bfa;
  border-radius: 6px;
  background: #7c3aed;
  color: #fff;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-ai-action:hover:not(:disabled) { background: #6d28d9; }
.btn-ai-action:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
