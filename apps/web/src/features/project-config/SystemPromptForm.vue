<script setup lang="ts">
import { fetchVariables } from '@/features/project-config/api';
import { onMounted, ref } from 'vue';
import AiAssistPanel from '@/features/agents/AiAssistPanel.vue';
import FormFooter from '@/ui/FormFooter.vue';
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
    {
      const defs: VariableDefinition[] = await fetchVariables('system-prompt');
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
    <!-- Franja 1 · qué es. El id NO es un campo: se deriva del nombre y no se
         edita, así que va como hint del campo del que sale. -->
    <div class="ff-row">
      <span class="uc-label">Nombre</span>
      <input
        :value="modelValue.name"
        class="ff-field"
        placeholder="Claude Code Identity"
        @input="updateName(($event.target as HTMLInputElement).value)"
      />
      <p v-if="idHint" class="ff-hint">id: <code>{{ idHint }}</code></p>
    </div>
    <!-- Franja 2 · qué hace, y acá es TODO el dominio: un system prompt es su
         texto. Diez filas y no cuatro — es el único campo que importa en esta
         pantalla y arrancaba ocupando menos que su propio encabezado. -->
    <div class="ff-row sp-text">
      <PromptField
        :model-value="modelValue.text"
        :rows="10"
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
    <!-- El pie no se pega: esta card se abre inline dentro de la lista, y una
         barra fija acá competiría con la tab bar del shell (R4). -->
    <FormFooter
      :sticky="false"
      :delete-label="variant === 'edit' ? 'Eliminar…' : undefined"
      :readonly="readonly"
      @save="emit('save')"
      @cancel="emit('cancel')"
      @delete="emit('delete')"
    />
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
/* `fieldset` y no `div`: `disabled` desactiva todo control anidado sin
   propagar un prop por `PromptField` y `AiAssistPanel`. Hay que neutralizarle
   el chrome que trae por default. */
.sp-form-fields {
  border: 0;
  margin: 0;
  padding: 0;
  min-inline-size: 0;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
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
  border-radius: var(--radius);
  padding: 0.75rem;
  margin-bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.sp-form--edit { border-color: var(--accent); }

/* El texto se lleva el alto que sobre: es el dominio entero de esta pantalla. */
.sp-text { flex: 1 1 auto; }

.sp-form-header { display: flex; justify-content: flex-end; }
/* `--ai` y el glifo son de salida de modelo, y de nada más (R16). */
.btn-ai-form {
  display: inline-flex;
  align-items: center;
  gap: 0.4ch;
  min-height: var(--tap-h-sm);
  padding: 0 0.9ch;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  font-size: var(--fs-body-sm);
  color: var(--fg-dim);
  cursor: pointer;
}
.btn-ai-form:hover { border-color: var(--ai); color: var(--ai); }
.btn-ai-form.active { border-color: var(--ai); background: var(--panel-hi); color: var(--ai); }
</style>
