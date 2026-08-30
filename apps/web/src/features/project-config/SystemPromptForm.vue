<script setup lang="ts">
import { apiBase } from '@/features/servers/selection';
import { onMounted, ref } from 'vue';
import AiAssistPanel from '@/features/agents/AiAssistPanel.vue';
import PromptField from '@/features/prompts/PromptField.vue';
import type { VariableGroup } from '@/features/prompts/PromptField.vue';
import type { VariableDefinition } from '@ia-flow/shared';

export interface SystemPromptDraft {
  name: string;
  text: string;
}

const props = defineProps<{
  modelValue: SystemPromptDraft;
  idHint?: string;
  variant?: 'new' | 'edit';
  /** El prompt es global y se está mirando desde un proyecto: se lee entero,
   *  no se guarda. El cuerpo va dentro de un `<fieldset disabled>` para que el
   *  navegador desactive todo control anidado —incluido el panel de IA y el
   *  editor de prompt— sin que cada uno reciba un prop. */
  readonly?: boolean;
  // Forwarded to PromptField → AiAssistPanel so its "referenciar system prompts"
  // list matches the scope of the parent (globals only in General, overlay in
  // a project view).
  availableSystemPrompts?: import('@ia-flow/shared').SystemPromptDef[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: SystemPromptDraft];
  save: [];
  cancel: [];
  delete: [];
}>();

const variableGroups = ref<VariableGroup[]>([]);

// ─── Form-level AI assist ──────────────────────────────────────────────────
// Form owns its own JSON schema (a tiny mirror of the SystemPromptDraft
// shape) and hands it to AiAssistPanel. The server forces a `fill_form`
// tool_use with this schema so the model returns { name?, text? } we can
// merge into the draft. Fields the model can't confidently infer are
// omitted — never overwritten with empty strings.
const FORM_SCHEMA = {
  type: 'object' as const,
  properties: {
    name: {
      type: 'string',
      description: 'Título humano corto del system prompt (Title Case, sin comillas).',
    },
    text: {
      type: 'string',
      description: 'Contenido completo del system prompt en markdown.',
    },
  },
  additionalProperties: false,
};

const aiOpen = ref(false);
// Text returned by fill_form. Routed through PromptField's diff view so the
// user can review before overwriting the (usually non-empty) existing text.
const pendingTextProposal = ref<string | null>(null);

function applyAiFields(fields: Record<string, unknown>) {
  const next: SystemPromptDraft = { ...props.modelValue };
  if (typeof fields.name === 'string' && fields.name.trim()) next.name = fields.name;
  const suggestedText =
    typeof fields.text === 'string' && fields.text.trim() ? fields.text : null;
  const shouldDiffText =
    suggestedText !== null && props.modelValue.text.trim() && suggestedText !== props.modelValue.text;
  if (suggestedText !== null && !shouldDiffText) next.text = suggestedText;
  emit('update:modelValue', next);
  if (shouldDiffText) pendingTextProposal.value = suggestedText;
  aiOpen.value = false;
}

onMounted(async () => {
  try {
    const API_BASE = apiBase();
    const res = await fetch(`${API_BASE}/api/variables?context=system-prompt`);
    if (res.ok) {
      const defs: VariableDefinition[] = await res.json();
      const byGroup = new Map<string, VariableDefinition[]>();
      for (const v of defs) {
        const g = v.group ?? 'system';
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g)!.push(v);
      }
      variableGroups.value = [...byGroup.entries()].map(([label, items]) => ({
        label,
        items: items.flatMap(v => {
          const formatted = `{{${v.key}}}`;
          const main = { label: formatted, value: formatted, hint: v.description };
          const subs = v.subfields
            ? Object.entries(v.subfields).map(([sf, meta]) => {
                const sub = `{{${v.key}.${sf}}}`;
                return { label: sub, value: sub, hint: meta.description };
              })
            : [];
          return [main, ...subs];
        }),
      }));
    }
  } catch { /* server may not be running */ }
});

function updateName(v: string) {
  emit('update:modelValue', { ...props.modelValue, name: v });
}

function updateText(v: string) {
  emit('update:modelValue', { ...props.modelValue, text: v });
}
</script>

<template>
  <div class="sp-form" :class="{ 'sp-form--edit': variant === 'edit' }">
    <p v-if="readonly" class="sp-ro-note">
      Es un system prompt <b>global</b>: los agentes de este proyecto lo pueden referenciar, pero
      se edita en <b>General → System Prompts</b>.
    </p>
    <fieldset class="sp-form-fields" :disabled="readonly">
    <div v-if="!readonly" class="sp-form-header">
      <button type="button" class="btn-ai-form" :class="{ active: aiOpen }" @click="aiOpen = !aiOpen">
        ✨ IA — Prellenar formulario
      </button>
    </div>
    <AiAssistPanel
      v-if="aiOpen"
      :current-prompt="modelValue.text"
      :template-context="'system-prompt'"
      :available-system-prompts="availableSystemPrompts"
      :hide-tool-chips="true"
      :response-schema="FORM_SCHEMA"
      description-optional
      :description-fallback="modelValue.name ? `Nombre actual: ${modelValue.name}` : undefined"
      @result-fields="applyAiFields"
    />
    <div class="field">
      <span class="field-label">Nombre</span>
      <input
        :value="modelValue.name"
        class="input"
        placeholder="Claude Code Identity"
        @input="updateName(($event.target as HTMLInputElement).value)"
      />
      <span v-if="idHint" class="field-hint">id: <code>{{ idHint }}</code></span>
    </div>
    <div class="field" style="margin-top: 0.5rem">
      <PromptField
        :model-value="modelValue.text"
        :rows="4"
        :variable-groups="variableGroups"
        template-context="system-prompt"
        label="Texto"
        :available-system-prompts="availableSystemPrompts"
        :pending-proposal="pendingTextProposal"
        @update:model-value="updateText"
        @clear-pending-proposal="pendingTextProposal = null"
      />
    </div>
    </fieldset>
    <div class="sp-form-actions">
      <!-- Borrar vive acá y no en la fila del listado: se hace una vez, no se
           deshace, y desde el formulario se ve QUÉ prompt se está por borrar. -->
      <button v-if="variant === 'edit' && !readonly" class="btn-delete-sm" @click="emit('delete')">Eliminar</button>
      <span class="sp-form-actions-spacer" />
      <button class="btn-cancel-sm" @click="emit('cancel')">
        {{ readonly ? 'Cerrar' : 'Cancelar' }}
      </button>
      <button v-if="!readonly" class="btn-save-sm" @click="emit('save')">Guardar</button>
    </div>
  </div>
</template>

<style scoped>
/* `fieldset` y no `div`: `disabled` desactiva todo control anidado sin
   propagar un prop por `PromptField` y `AiAssistPanel`. Hay que neutralizarle
   el chrome que trae por default. */
.sp-form-fields {
  border: 0;
  margin: 0;
  padding: 0;
  min-inline-size: 0;
}

.sp-ro-note {
  margin: 0 0 0.5rem;
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  line-height: 1.5;
}

.sp-form {
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem;
  margin-bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.sp-form--edit { border-color: var(--accent); background: var(--panel-alt); }
.sp-form-header { display: flex; justify-content: flex-end; margin-bottom: 0.25rem; }
.btn-ai-form {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  background: var(--panel);
  font-size: 0.78rem;
  color: var(--fg-dim);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.btn-ai-form:hover { border-color: var(--magenta); color: var(--magenta); }
.btn-ai-form.active { border-color: var(--magenta); background: var(--panel-hi); color: var(--magenta); }
.sp-form-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.25rem; }
.sp-form-actions-spacer { flex: 1; }
.btn-delete-sm {
  padding: 0.3rem 0.75rem;
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--danger);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.btn-delete-sm:hover { background: var(--red-bg); }
.field { display: flex; flex-direction: column; gap: 0.25rem; }
.field-label { font-size: 0.8rem; font-weight: 500; color: var(--fg-mute); }
.field-hint { font-size: 0.72rem; color: var(--fg-dim); }
.field-hint code {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  background: var(--panel-hi);
  padding: 0.05rem 0.25rem;
  border-radius: 3px;
}
.input {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.84rem;
  color: var(--fg);
  background: var(--panel);
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
.btn-cancel-sm {
  padding: 0.3rem 0.85rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  background: var(--panel);
  font-size: 0.8rem;
  cursor: pointer;
  color: var(--fg-mute);
}
.btn-save-sm {
  padding: 0.3rem 0.85rem;
  border: none;
  border-radius: 5px;
  background: var(--accent);
  color: var(--panel);
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-save-sm:hover { background: var(--accent); }
</style>
