<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { AgentConfig, AgentStepConfig, AgentVariant } from '@ia-flow/shared';

interface KV { key: string; value: string }
interface VariantDraft {
  conditions: KV[];
  prompt: string;
  provider: string;
  outputSection: string;
  variables: KV[];
}

const props = defineProps<{
  open: boolean;
  agent: AgentConfig | null;
  providers: { id: string; name: string }[];
}>();

const emit = defineEmits<{
  close: [];
  save: [agent: AgentConfig];
}>();

// ─── Form state ───────────────────────────────────────────────────────────────

const onStatus   = ref('');
const onProcess  = ref('');
const onFinish   = ref('');
const onError    = ref('');
const contextRepos = ref<'task' | 'custom'>('task');
const contextRepoList = ref('');

// Default config
const defProvider      = ref('anthropic-api');
const defPrompt        = ref('');
const defOutputSection = ref('');
const defVariables     = ref<KV[]>([]);

// Variants
const variants = ref<VariantDraft[]>([]);

// ─── Hydrate when opening ─────────────────────────────────────────────────────

watch(() => props.open, (open) => {
  if (!open) return;
  const a = props.agent;
  if (a) {
    onStatus.value   = a.onStatus;
    onProcess.value  = a.onProcess ?? '';
    onFinish.value   = a.onFinish ?? '';
    onError.value    = a.onError ?? '';

    const repos = a.context?.repos;
    if (!repos || repos === 'task') {
      contextRepos.value = 'task';
      contextRepoList.value = '';
    } else {
      contextRepos.value = 'custom';
      contextRepoList.value = (repos as string[]).join(', ');
    }

    defProvider.value      = a.default.provider;
    defPrompt.value        = a.default.prompt;
    defOutputSection.value = a.default.output?.section ?? '';
    defVariables.value     = Object.entries(a.default.variables ?? {}).map(([key, value]) => ({ key, value }));

    variants.value = (a.variants ?? []).map((v) => ({
      conditions: Object.entries(v.when).map(([key, value]) => ({ key, value })),
      prompt:        v.prompt ?? '',
      provider:      v.provider ?? '',
      outputSection: v.output?.section ?? '',
      variables:     Object.entries(v.variables ?? {}).map(([key, value]) => ({ key, value })),
    }));
  } else {
    onStatus.value   = '';
    onProcess.value  = '';
    onFinish.value   = '';
    onError.value    = '';
    contextRepos.value    = 'task';
    contextRepoList.value = '';
    defProvider.value      = props.providers[0]?.id ?? 'anthropic-api';
    defPrompt.value        = '';
    defOutputSection.value = '';
    defVariables.value     = [];
    variants.value         = [];
  }
});

// ─── Variables helpers ────────────────────────────────────────────────────────

function addVariable(list: KV[]) { list.push({ key: '', value: '' }); }
function removeVariable(list: KV[], i: number) { list.splice(i, 1); }
function kvToRecord(list: KV[]): Record<string, string> {
  return Object.fromEntries(list.filter(kv => kv.key).map(kv => [kv.key, kv.value]));
}

// ─── Variant helpers ──────────────────────────────────────────────────────────

function addVariant() {
  variants.value.push({ conditions: [{ key: '', value: '' }], prompt: '', provider: '', outputSection: '', variables: [] });
}
function removeVariant(i: number) { variants.value.splice(i, 1); }
function addCondition(v: VariantDraft) { v.conditions.push({ key: '', value: '' }); }
function removeCondition(v: VariantDraft, i: number) { v.conditions.splice(i, 1); }

// ─── Validation ───────────────────────────────────────────────────────────────

const errors = ref<string[]>([]);

function validate(): boolean {
  errors.value = [];
  if (!onStatus.value.trim()) errors.value.push('El trigger status (onStatus) es requerido.');
  if (!defProvider.value.trim()) errors.value.push('El provider por defecto es requerido.');
  if (!defPrompt.value.trim()) errors.value.push('El prompt por defecto es requerido.');
  for (const [i, v] of variants.value.entries()) {
    if (!v.conditions.length || v.conditions.some(c => !c.key.trim())) {
      errors.value.push(`Variante ${i + 1}: todas las condiciones deben tener un campo.`);
    }
  }
  return errors.value.length === 0;
}

// ─── Save ─────────────────────────────────────────────────────────────────────

function buildAgent(): AgentConfig {
  const defaultStep: AgentStepConfig = {
    provider: defProvider.value,
    prompt: defPrompt.value,
  };
  if (defVariables.value.length) defaultStep.variables = kvToRecord(defVariables.value);
  if (defOutputSection.value.trim()) defaultStep.output = { section: defOutputSection.value.trim() };

  const builtVariants: AgentVariant[] = variants.value
    .filter(v => v.conditions.some(c => c.key.trim()))
    .map(v => {
      const variant: AgentVariant = {
        when: Object.fromEntries(v.conditions.filter(c => c.key.trim()).map(c => [c.key.trim(), c.value.trim()])),
      };
      if (v.prompt.trim()) variant.prompt = v.prompt.trim();
      if (v.provider.trim()) variant.provider = v.provider.trim();
      if (v.outputSection.trim()) variant.output = { section: v.outputSection.trim() };
      if (v.variables.length) variant.variables = kvToRecord(v.variables);
      return variant;
    });

  const agent: AgentConfig = {
    onStatus: onStatus.value.trim(),
    default: defaultStep,
  };
  if (onProcess.value.trim()) agent.onProcess = onProcess.value.trim();
  if (onFinish.value.trim()) agent.onFinish = onFinish.value.trim();
  if (onError.value.trim()) agent.onError = onError.value.trim();

  const repos = contextRepos.value === 'task'
    ? 'task'
    : contextRepoList.value.split(',').map(s => s.trim()).filter(Boolean);
  agent.context = { repos };

  if (builtVariants.length) agent.variants = builtVariants;

  return agent;
}

function onSave() {
  if (!validate()) return;
  emit('save', buildAgent());
}

const title = computed(() => props.agent ? `Editar agente — ${props.agent.onStatus}` : 'Nuevo agente');
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>{{ title }}</h3>
        <button class="close-btn" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">

        <!-- ── Status Flow ───────────────────────────────────────── -->
        <section class="form-section">
          <h4>Flujo de estados</h4>
          <p class="form-hint">Define qué status dispara este agente y a qué status transiciona.</p>
          <div class="grid-2">
            <label class="field">
              <span class="label">Trigger <span class="req">*</span></span>
              <input v-model="onStatus" class="input" placeholder="queued" />
              <span class="field-hint">Status que activa el agente</span>
            </label>
            <label class="field">
              <span class="label">En proceso</span>
              <input v-model="onProcess" class="input" placeholder="refining" />
              <span class="field-hint">Status mientras corre (opcional)</span>
            </label>
            <label class="field">
              <span class="label">Al terminar</span>
              <input v-model="onFinish" class="input" placeholder="refined" />
              <span class="field-hint">Status si todo va bien (opcional)</span>
            </label>
            <label class="field">
              <span class="label">Al fallar</span>
              <input v-model="onError" class="input" placeholder="failed" />
              <span class="field-hint">Status si hay error (opcional)</span>
            </label>
          </div>
        </section>

        <!-- ── Context ──────────────────────────────────────────── -->
        <section class="form-section">
          <h4>Contexto de repos</h4>
          <div class="radio-row">
            <label class="radio-label">
              <input v-model="contextRepos" type="radio" value="task" />
              <span>task — todos los repos de la tarea</span>
            </label>
            <label class="radio-label">
              <input v-model="contextRepos" type="radio" value="custom" />
              <span>Lista específica</span>
            </label>
          </div>
          <input
            v-if="contextRepos === 'custom'"
            v-model="contextRepoList"
            class="input"
            placeholder="backend, frontend, mobile  (separados por coma)"
            style="margin-top: 0.5rem;"
          />
        </section>

        <!-- ── Default Config ───────────────────────────────────── -->
        <section class="form-section">
          <h4>Configuración por defecto</h4>

          <label class="field">
            <span class="label">Provider <span class="req">*</span></span>
            <select v-model="defProvider" class="input select">
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name ?? p.id }}</option>
            </select>
          </label>

          <label class="field" style="margin-top: 0.75rem;">
            <span class="label">Prompt <span class="req">*</span></span>
            <span class="field-hint" style="margin-bottom: 0.35rem;">
              Ruta de archivo (<code>./prompts/mi-prompt.md</code>) o texto inline.
              Variables: <code v-pre>{{task.title}}</code>, <code v-pre>{{variables.lang}}</code>, <code v-pre>{{context.repos}}</code>
            </span>
            <textarea v-model="defPrompt" class="textarea" rows="6" placeholder="./prompts/refine-functional.md  o texto del prompt aquí…" />
          </label>

          <label class="field" style="margin-top: 0.75rem;">
            <span class="label">Output → sección</span>
            <input v-model="defOutputSection" class="input" placeholder="functional_prd" />
            <span class="field-hint">Nombre de la sección donde se guarda el resultado. Accesible como <code v-pre>{{task.sections.nombre}}</code></span>
          </label>

          <div class="field" style="margin-top: 0.75rem;">
            <span class="label">Variables</span>
            <span class="field-hint">Disponibles en el prompt como <code v-pre>{{variables.key}}</code></span>
            <div class="kv-list">
              <div v-for="(kv, i) in defVariables" :key="i" class="kv-row">
                <input v-model="kv.key"   class="input kv-key"   placeholder="key" />
                <span class="kv-eq">=</span>
                <input v-model="kv.value" class="input kv-value" placeholder="value" />
                <button class="kv-remove" @click="removeVariable(defVariables, i)">✕</button>
              </div>
              <button class="btn-add-kv" @click="addVariable(defVariables)">+ Variable</button>
            </div>
          </div>
        </section>

        <!-- ── Variants ─────────────────────────────────────────── -->
        <section class="form-section">
          <div class="section-head">
            <div>
              <h4>Variantes</h4>
              <p class="form-hint">Se aplica la primera variante cuyas condiciones hagan match (igualdad exacta sobre campos de la tarea).</p>
            </div>
            <button class="btn-add-variant" @click="addVariant">+ Variante</button>
          </div>

          <div v-for="(v, vi) in variants" :key="vi" class="variant-card">
            <div class="variant-head">
              <span class="variant-title">Variante {{ vi + 1 }}</span>
              <button class="kv-remove" @click="removeVariant(vi)">✕</button>
            </div>

            <div class="field">
              <span class="label">Condiciones (when)</span>
              <div class="kv-list">
                <div v-for="(c, ci) in v.conditions" :key="ci" class="kv-row">
                  <input v-model="c.key"   class="input kv-key"   placeholder="type" />
                  <span class="kv-eq">=</span>
                  <input v-model="c.value" class="input kv-value" placeholder="functional" />
                  <button class="kv-remove" @click="removeCondition(v, ci)">✕</button>
                </div>
                <button class="btn-add-kv" @click="addCondition(v)">+ Condición</button>
              </div>
            </div>

            <div class="grid-2" style="margin-top: 0.5rem;">
              <label class="field">
                <span class="label">Provider override</span>
                <select v-model="v.provider" class="input select">
                  <option value="">(heredar default)</option>
                  <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name ?? p.id }}</option>
                </select>
              </label>
              <label class="field">
                <span class="label">Output section override</span>
                <input v-model="v.outputSection" class="input" placeholder="technical_prd" />
              </label>
            </div>

            <label class="field" style="margin-top: 0.5rem;">
              <span class="label">Prompt override</span>
              <textarea v-model="v.prompt" class="textarea" rows="3" placeholder="./prompts/refine-technical.md  (vacío = heredar default)" />
            </label>

            <div class="field" style="margin-top: 0.5rem;">
              <span class="label">Variables override</span>
              <div class="kv-list">
                <div v-for="(kv, i) in v.variables" :key="i" class="kv-row">
                  <input v-model="kv.key"   class="input kv-key"   placeholder="key" />
                  <span class="kv-eq">=</span>
                  <input v-model="kv.value" class="input kv-value" placeholder="value" />
                  <button class="kv-remove" @click="removeVariable(v.variables, i)">✕</button>
                </div>
                <button class="btn-add-kv" @click="addVariable(v.variables)">+ Variable</button>
              </div>
            </div>
          </div>

          <div v-if="!variants.length" class="variants-empty">
            Sin variantes — se usa siempre la configuración por defecto.
          </div>
        </section>

        <!-- ── Errors ────────────────────────────────────────────── -->
        <div v-if="errors.length" class="error-list">
          <p v-for="e in errors" :key="e">{{ e }}</p>
        </div>

      </div>

      <div class="modal-foot">
        <button class="btn-cancel" @click="emit('close')">Cancelar</button>
        <button class="btn-save" @click="onSave">Guardar agente</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── Overlay & modal ─────────────────────────────────────────────────────── */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 1rem;
}
.modal {
  background: #fff;
  border-radius: 12px;
  width: min(720px, 100%);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.22);
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem 0.75rem;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.modal-head h3 { margin: 0; font-size: 1rem; }
.close-btn {
  background: none;
  border: none;
  font-size: 1rem;
  color: #6b7280;
  cursor: pointer;
  padding: 0.2rem 0.4rem;
  line-height: 1;
}
.close-btn:hover { color: #111; }
.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem 1rem;
  border-top: 1px solid #f3f4f6;
  flex-shrink: 0;
}

/* ── Form sections ───────────────────────────────────────────────────────── */
.form-section {
  padding: 1rem 0;
  border-bottom: 1px solid #f3f4f6;
}
.form-section:last-child { border-bottom: none; }
.form-section h4 {
  margin: 0 0 0.2rem;
  font-size: 0.88rem;
  font-weight: 600;
  color: #1e293b;
}
.form-hint {
  margin: 0 0 0.75rem;
  font-size: 0.77rem;
  color: #6b7280;
  line-height: 1.4;
}
.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}
.section-head h4 { margin: 0 0 0.15rem; }
.section-head p { margin: 0; }

/* ── Grid ────────────────────────────────────────────────────────────────── */
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.65rem 1rem;
}

/* ── Field ───────────────────────────────────────────────────────────────── */
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.label {
  font-size: 0.8rem;
  font-weight: 500;
  color: #374151;
}
.req { color: #ef4444; }
.field-hint {
  font-size: 0.73rem;
  color: #9ca3af;
  line-height: 1.4;
}
.field-hint code {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  background: #f3f4f6;
  padding: 0.05rem 0.25rem;
  border-radius: 3px;
}

/* ── Inputs ──────────────────────────────────────────────────────────────── */
.input {
  padding: 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.84rem;
  color: #1e293b;
  background: #fff;
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
.select { cursor: pointer; }
.textarea {
  padding: 0.5rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.8rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: #1e293b;
  background: #f8fafc;
  resize: vertical;
  width: 100%;
  box-sizing: border-box;
  outline: none;
  line-height: 1.55;
}
.textarea:focus { border-color: #2563eb; background: #fff; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }

/* ── Radio ───────────────────────────────────────────────────────────────── */
.radio-row { display: flex; gap: 1.5rem; }
.radio-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.83rem;
  cursor: pointer;
  color: #374151;
}

/* ── KV editor ───────────────────────────────────────────────────────────── */
.kv-list { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.25rem; }
.kv-row { display: flex; align-items: center; gap: 0.35rem; }
.kv-key { flex: 1 1 6rem; min-width: 0; }
.kv-value { flex: 2 1 10rem; min-width: 0; }
.kv-eq { color: #9ca3af; font-size: 0.85rem; flex-shrink: 0; }
.kv-remove {
  flex-shrink: 0;
  background: none;
  border: none;
  color: #ef4444;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0.1rem 0.3rem;
  line-height: 1;
  opacity: 0.7;
}
.kv-remove:hover { opacity: 1; }
.btn-add-kv {
  align-self: flex-start;
  background: none;
  border: 1px dashed #d1d5db;
  border-radius: 5px;
  color: #6b7280;
  font-size: 0.78rem;
  padding: 0.25rem 0.6rem;
  cursor: pointer;
}
.btn-add-kv:hover { border-color: #2563eb; color: #2563eb; }

/* ── Variants ────────────────────────────────────────────────────────────── */
.btn-add-variant {
  flex-shrink: 0;
  padding: 0.3rem 0.8rem;
  background: #ede9fe;
  color: #5b21b6;
  border: none;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.btn-add-variant:hover { background: #ddd6fe; }
.variant-card {
  border: 1px solid #e9d5ff;
  border-radius: 8px;
  padding: 0.75rem 0.85rem;
  background: #faf5ff;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.variant-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.variant-title { font-size: 0.8rem; font-weight: 600; color: #5b21b6; }
.variants-empty {
  font-size: 0.8rem;
  color: #9ca3af;
  font-style: italic;
  padding: 0.25rem 0;
}

/* ── Errors ──────────────────────────────────────────────────────────────── */
.error-list {
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin-top: 0.25rem;
}
.error-list p { margin: 0.15rem 0; font-size: 0.8rem; color: #dc2626; }

/* ── Footer buttons ──────────────────────────────────────────────────────── */
.btn-cancel {
  padding: 0.4rem 1rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 0.875rem;
  cursor: pointer;
  color: #374151;
}
.btn-cancel:hover { background: #f9fafb; }
.btn-save {
  padding: 0.4rem 1.2rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-save:hover { background: #1d4ed8; }
</style>
