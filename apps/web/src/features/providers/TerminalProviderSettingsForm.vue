<script setup lang="ts">
// Provider-wide defaults para tmux-claude / iterm-claude. Sirven de fallback
// cuando el agente no define `providerConfig` (ver AgentEditorModal).
// Precedencia efectiva: agent.providerConfig > estos defaults.
import { ref, watch } from 'vue';
import type { McpServers, TerminalProviderSettings } from '@ia-flow/shared';
import ConcurrencyCapField from '@/ui/ConcurrencyCapField.vue';
import McpServersEditor from './McpServersEditor.vue';
import ModelSelect from './ModelSelect.vue';

const props = withDefaults(
  defineProps<{
    modelValue: TerminalProviderSettings;
    // Sólo tmux-claude: para iterm-claude abrir el tab ES el provider, así que
    // el toggle no se muestra ahí (no tendría nada que apagar).
    showSurfaceInTerminal?: boolean;
  }>(),
  { showSurfaceInTerminal: false },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: TerminalProviderSettings): void;
}>();

function update<K extends keyof TerminalProviderSettings>(key: K, value: TerminalProviderSettings[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function updateModel(val: string) {
  update('model', val || undefined);
}

// ─── Env vars editor ─────────────────────────────────────────────────────────

interface KV { key: string; value: string }

function recordToKv(record: Record<string, string> | undefined): KV[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}

const pairs = ref<KV[]>(recordToKv(props.modelValue.env));

watch(() => props.modelValue.env, (env) => {
  pairs.value = recordToKv(env);
}, { deep: true });

function toRecord(): Record<string, string> {
  return Object.fromEntries(pairs.value.filter(p => p.key).map(p => [p.key, p.value]));
}

function onEnvChange() {
  update('env', toRecord());
}

function addPair() {
  pairs.value.push({ key: '', value: '' });
}

function removePair(i: number) {
  pairs.value.splice(i, 1);
  update('env', toRecord());
}

function updateMcp(value: McpServers) {
  update('mcpServers', value);
}
</script>

<template>
  <div class="terminal-form">
    <div class="ff-row">
      <label class="uc-label">Model</label>
      <ModelSelect :model-value="modelValue.model" allow-empty @update:model-value="updateModel($event ?? '')" />
    </div>

    <div class="ff-row">
      <ConcurrencyCapField
        :model-value="modelValue.maxConcurrentRuns ?? null"
        label="Máx. runs en paralelo"
        hint="Un agente que declara varios providers candidatos salta al siguiente cuando este está al tope; si ninguno puede, el issue queda en cola."
        @update:model-value="update('maxConcurrentRuns', $event ?? undefined)"
      />
    </div>

    <div class="ff-row">
      <label class="ff-check" for="terminal-skip-permissions">
        <input
          id="terminal-skip-permissions"
          type="checkbox"
          :checked="modelValue.dangerouslySkipPermissions ?? false"
          @change="update('dangerouslySkipPermissions', ($event.target as HTMLInputElement).checked)"
        />
        --dangerously-skip-permissions
      </label>
    </div>

    <div v-if="showSurfaceInTerminal" class="ff-row">
      <label class="ff-check" for="terminal-surface">
        <input
          id="terminal-surface"
          type="checkbox"
          :checked="modelValue.surfaceInTerminal ?? false"
          @change="update('surfaceInTerminal', ($event.target as HTMLInputElement).checked)"
        />
        Abrir la sesión en iTerm
      </label>
      <span class="ff-hint">Apagado, la sesión corre en background: <code>tmux attach -t &lt;sesión&gt;</code> para mirarla.</span>
    </div>

    <div class="ff-row tf-group">
      <span class="uc-label">Variables de entorno</span>
      <span class="ff-hint">Se exportan antes de ejecutar Claude. Útil para <code>ANTHROPIC_API_KEY</code>, <code>GH_TOKEN</code>, etc.</span>

      <div class="ff-list">
        <div v-for="(pair, i) in pairs" :key="i" class="ff-list-row">
          <input
            class="ff-field ff-mono ff-list-key"
            placeholder="VARIABLE"
            :value="pair.key"
            @input="pair.key = ($event.target as HTMLInputElement).value; onEnvChange()"
          />
          <span class="ff-eq">=</span>
          <input
            class="ff-field ff-mono ff-list-val"
            placeholder="valor"
            :value="pair.value"
            @input="pair.value = ($event.target as HTMLInputElement).value; onEnvChange()"
          />
          <button type="button" class="ff-drop" title="Eliminar" @click="removePair(i)">✕</button>
        </div>
      </div>

      <button type="button" class="ff-add" @click="addPair">+ Agregar variable</button>
    </div>

    <div class="ff-row tf-group">
      <span class="uc-label">MCP servers</span>
      <McpServersEditor :model-value="modelValue.mcpServers" @update:model-value="updateMcp" />
    </div>
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>
<style scoped>
/* Todo lo que era propio de acá —la fila etiqueta-a-la-izquierda, el input con
   su `box-shadow` azul fuera de la paleta, la lista `kv-*` de variables de
   entorno, sus botones de alta y baja— es el kit compartido. Lo único que
   sobrevive es el separador de bloque, que sí es de este formulario. */
.terminal-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.tf-group {
  gap: 0.35rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--panel-hi);
  margin-top: 0.25rem;
}
</style>
