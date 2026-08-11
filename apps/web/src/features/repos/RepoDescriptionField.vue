<script setup lang="ts">
import { diffLines } from 'diff';
import { computed, ref } from 'vue';
import AiAssistPanel from '@/features/agents/AiAssistPanel.vue';
import { useToastStore } from '@/stores/toast';

// Textarea + AI assist for a single repo `description`. Mirrors the pattern
// used by PromptField (toggle IA → panel → diff → apply/discard), stripped
// of variable chips / rich prompt editor since a repo description is plain
// text.

const props = defineProps<{
  modelValue: string;
  // Form fields serialized as the "context" that the AI receives when the
  // instructions textarea in the panel is empty.
  contextFallback: string;
  // Sysprompt id to pre-select for the assist call (the seed prompt).
  systemPromptId: string;
  // Human-readable summary of the context (rendered above the panel so the
  // user sees what the AI is being handed).
  contextPreview?: string;
  // Blocks the IA toggle when there's not enough context to generate.
  aiDisabled?: boolean;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  // Tool names to pre-select in the AI panel (fs tools by default so the
  // assistant can read files at the repo path).
  defaultTools?: string[];
  // Repo contexts forwarded to the assist endpoint so fs tools can
  // resolve "<repo-name>/relative/path".
  repoContexts?: Array<{ name: string; path: string }>;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const toastStore = useToastStore();

const aiPanelOpen = ref(false);
const aiProposed = ref<string | null>(null);
const aiPendingMode = ref<'generate' | 'refine'>('generate');
const aiEditing = ref(false);

interface DiffLine { text: string; added: boolean; removed: boolean }

const aiDiffLines = computed<DiffLine[]>(() => {
  if (aiProposed.value === null) return [];
  return diffLines(props.modelValue, aiProposed.value).flatMap((change) =>
    change.value
      .split('\n')
      .filter((line, i, arr) => !(i === arr.length - 1 && line === ''))
      .map((text) => ({ text, added: !!change.added, removed: !!change.removed })),
  );
});

const assistBaselinePrompt = computed(() => aiProposed.value ?? props.modelValue);

function onAiResult(newPrompt: string, mode: 'generate' | 'refine') {
  // Server returns a full paragraph; enforce one line for the description.
  const single = newPrompt.trim().split('\n')[0].trim();
  aiPendingMode.value = mode;
  aiProposed.value = single;
  aiEditing.value = false;
  aiPanelOpen.value = true;
}

function applyProposal() {
  if (aiProposed.value === null) return;
  emit('update:modelValue', aiProposed.value);
  aiProposed.value = null;
  aiEditing.value = false;
  aiPanelOpen.value = false;
  toastStore.success(aiPendingMode.value === 'generate' ? 'Descripción generada ✨' : 'Descripción mejorada ✨');
}

function discardProposal() {
  aiProposed.value = null;
  aiEditing.value = false;
}

function toggleEdit() {
  aiEditing.value = !aiEditing.value;
}
</script>

<template>
  <div class="rdf">
    <div class="rdf__label-row">
      <label class="rdf__label">Descripción</label>
      <button
        type="button"
        class="rdf__ia-btn"
        :class="{ active: aiPanelOpen }"
        :disabled="aiDisabled"
        :title="aiDisabled ? 'Completa Path o GitHub para generar con IA' : 'Asistente IA'"
        @click="aiPanelOpen = !aiPanelOpen"
      >
        ✨ IA
      </button>
    </div>

    <div v-if="aiPanelOpen && contextPreview" class="rdf__context-preview">
      <span class="rdf__context-label">Contexto:</span>
      <span class="rdf__context-value">{{ contextPreview }}</span>
    </div>

    <AiAssistPanel
      v-if="aiPanelOpen"
      :current-prompt="assistBaselinePrompt"
      :has-proposal="aiProposed !== null"
      :agent-id="'repo-description'"
      :description-optional="true"
      :description-fallback="contextFallback"
      :default-system-prompt-ids="[systemPromptId]"
      :default-tools="defaultTools"
      :repo-contexts="repoContexts"
      @result="onAiResult"
    />

    <div v-if="aiProposed !== null" class="rdf__diff">
      <div class="rdf__diff-header">
        <span class="rdf__diff-title">
          {{ aiPendingMode === 'generate' ? 'Descripción generada' : 'Cambios propuestos' }}
        </span>
        <div class="rdf__diff-actions">
          <button type="button" class="rdf__btn-edit" :class="{ active: aiEditing }" @click="toggleEdit">
            {{ aiEditing ? '👁 Ver diff' : '✏️ Editar' }}
          </button>
          <button type="button" class="rdf__btn-discard" @click="discardProposal">Descartar</button>
          <button type="button" class="rdf__btn-apply" @click="applyProposal">Aplicar</button>
        </div>
      </div>
      <div v-if="!aiEditing" class="rdf__diff-view">
        <div
          v-for="(line, i) in aiDiffLines"
          :key="i"
          class="rdf__diff-line"
          :class="{ 'rdf__diff-line--added': line.added, 'rdf__diff-line--removed': line.removed }"
        >
          <span class="rdf__diff-marker">{{ line.added ? '+' : line.removed ? '−' : ' ' }}</span>
          <span class="rdf__diff-text">{{ line.text || ' ' }}</span>
        </div>
      </div>
      <textarea
        v-else
        class="rdf__proposal"
        :value="aiProposed"
        rows="3"
        @input="aiProposed = ($event.target as HTMLTextAreaElement).value"
      />
    </div>

    <textarea
      class="rdf__textarea"
      :value="modelValue"
      :placeholder="placeholder ?? 'Breve descripción del repo (qué es, para qué se usa).'"
      :rows="rows ?? 3"
      :disabled="disabled"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
  </div>
</template>

<style scoped>
.rdf { display: flex; flex-direction: column; gap: 0.4rem; }

.rdf__label-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.rdf__label { font-size: 0.78rem; font-weight: 600; color: #374151; }
.rdf__ia-btn {
  padding: 0.2rem 0.6rem;
  border: 1px solid #c7d2fe;
  border-radius: 6px;
  background: linear-gradient(135deg, #eef2ff 0%, #f5f3ff 100%);
  color: #4338ca;
  font-size: 0.72rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.rdf__ia-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #e0e7ff 0%, #ede9fe 100%);
  border-color: #a5b4fc;
}
.rdf__ia-btn.active {
  background: #ede9fe;
  border-color: #a5b4fc;
  color: #5b21b6;
}
.rdf__ia-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.rdf__context-preview {
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
  padding: 0.35rem 0.6rem;
  background: #f5f3ff;
  border: 1px dashed #ddd6fe;
  border-radius: 6px;
  font-size: 0.72rem;
  color: #6b7280;
}
.rdf__context-label { font-weight: 600; color: #7c3aed; }
.rdf__context-value {
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: #1e293b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rdf__textarea {
  padding: 0.55rem 0.7rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.86rem;
  color: #1e293b;
  background: #fff;
  width: 100%;
  box-sizing: border-box;
  outline: none;
  resize: vertical;
  min-height: 4.5rem;
  line-height: 1.5;
  font-family: inherit;
}
.rdf__textarea:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
.rdf__textarea:disabled { background: #f9fafb; color: #6b7280; }

.rdf__diff {
  border: 1px solid #e0e7ff;
  border-radius: 8px;
  background: #f8fafc;
  overflow: hidden;
}
.rdf__diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.75rem;
  background: #eef2ff;
  border-bottom: 1px solid #e0e7ff;
}
.rdf__diff-title { font-size: 0.78rem; font-weight: 600; color: #4338ca; }
.rdf__diff-actions { display: flex; gap: 0.35rem; }
.rdf__btn-edit,
.rdf__btn-discard,
.rdf__btn-apply {
  padding: 0.2rem 0.6rem;
  border-radius: 5px;
  font-size: 0.72rem;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
}
.rdf__btn-edit { background: #fff; border-color: #d1d5db; color: #374151; }
.rdf__btn-edit:hover { background: #f3f4f6; }
.rdf__btn-edit.active { background: #e0e7ff; border-color: #a5b4fc; color: #4338ca; }
.rdf__btn-discard { background: #fff; border-color: #fca5a5; color: #b91c1c; }
.rdf__btn-discard:hover { background: #fee2e2; }
.rdf__btn-apply { background: #4338ca; color: #fff; border-color: #4338ca; }
.rdf__btn-apply:hover { background: #3730a3; }

.rdf__diff-view {
  padding: 0.4rem 0;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.78rem;
}
.rdf__diff-line { display: flex; padding: 0.05rem 0.75rem; }
.rdf__diff-line--added { background: #dcfce7; color: #14532d; }
.rdf__diff-line--removed { background: #fee2e2; color: #7f1d1d; }
.rdf__diff-marker { width: 1.2rem; opacity: 0.6; }
.rdf__diff-text { white-space: pre-wrap; word-break: break-word; }

.rdf__proposal {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.75rem;
  border: none;
  background: #fff;
  font-family: inherit;
  font-size: 0.86rem;
  color: #1e293b;
  outline: none;
  resize: vertical;
  min-height: 3.5rem;
}
</style>
