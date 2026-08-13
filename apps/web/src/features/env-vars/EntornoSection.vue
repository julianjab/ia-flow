<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useEnvVarsStore } from '@/features/env-vars/store';
import { useToastStore } from '@/stores/toast';

const envVarsStore = useEnvVarsStore();
const toastStore = useToastStore();

const envDrafts = ref<Record<string, string>>({});

const envGroups = computed(() => {
  const groups = new Map<string, { group: string; label: string; keys: string[] }>();
  for (const [key, state] of Object.entries(envVarsStore.vars)) {
    const entry = groups.get(state.group);
    if (entry) entry.keys.push(key);
    else groups.set(state.group, { group: state.group, label: state.groupLabel, keys: [key] });
  }
  return Array.from(groups.values());
});

function initEnvDrafts() {
  const drafts: Record<string, string> = {};
  for (const [key, state] of Object.entries(envVarsStore.vars)) {
    drafts[key] = state.secret ? '' : (state.value ?? '');
  }
  envDrafts.value = drafts;
}

watch(() => envVarsStore.vars, initEnvDrafts, { deep: true });

async function onSaveEntorno() {
  const patch: Record<string, string> = {};
  for (const [key, state] of Object.entries(envVarsStore.vars)) {
    const draft = envDrafts.value[key] ?? '';
    if (state.secret) {
      if (draft.trim()) patch[key] = draft.trim();
    } else {
      patch[key] = draft;
    }
  }
  if (!Object.keys(patch).length) {
    toastStore.success('Sin cambios que guardar');
    return;
  }
  try {
    await envVarsStore.save(patch);
    for (const [key, state] of Object.entries(envVarsStore.vars)) {
      if (state.secret) envDrafts.value[key] = '';
    }
    toastStore.success('Variables de entorno guardadas');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

onMounted(async () => {
  try {
    await envVarsStore.fetch();
    initEnvDrafts();
  } catch {
    /* non-critical */
  }
});
</script>

<template>
  <section class="settings-section">
    <h2>Variables de entorno</h2>
    <p class="section-desc">
      Configura las credenciales y opciones del servidor. Los valores aquí tienen precedencia
      sobre las variables de entorno del proceso — si no hay valor configurado, se usa el
      valor del entorno como fallback.
    </p>

    <div v-if="envVarsStore.loading" class="repos-empty">Cargando…</div>

    <form v-else class="env-var-list" autocomplete="off" @submit.prevent="onSaveEntorno">
      <div v-for="group in envGroups" :key="group.group" class="env-var-group">
        <h3 class="env-var-group-title">{{ group.label }}</h3>
        <div v-for="key in group.keys" :key="key" class="env-var-row">
          <div class="env-var-meta">
            <div class="env-var-header">
              <code class="env-var-key">{{ key }}</code>
              <span v-if="envVarsStore.vars[key].isSet" class="env-set-badge">configurada</span>
              <span v-else class="env-unset-badge">no configurada</span>
            </div>
            <p class="env-var-desc">{{ envVarsStore.vars[key].description }}</p>
          </div>

          <input
            v-if="envVarsStore.vars[key].kind === 'password'"
            v-model="envDrafts[key]"
            type="password"
            class="input env-var-input"
            :placeholder="envVarsStore.vars[key].isSet ? 'Dejar en blanco para conservar el valor actual' : 'Introduce el valor…'"
            autocomplete="off"
          />

          <select
            v-else-if="envVarsStore.vars[key].kind === 'select'"
            v-model="envDrafts[key]"
            class="input select env-var-input"
          >
            <option value="">— sin configurar —</option>
            <option v-for="opt in envVarsStore.vars[key].options ?? []" :key="opt" :value="opt">
              {{ opt }}
            </option>
          </select>

          <input
            v-else
            v-model="envDrafts[key]"
            type="text"
            class="input env-var-input"
            :placeholder="envVarsStore.vars[key].label"
          />
        </div>
      </div>

      <footer class="settings-actions" style="margin-top: 1.25rem;">
        <button type="submit" class="save-button" :disabled="envVarsStore.saving">
          {{ envVarsStore.saving ? 'Guardando…' : 'Guardar variables' }}
        </button>
      </footer>
    </form>
  </section>
</template>

<style scoped>
.settings-section { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: var(--fg-dim); line-height: 1.5; }
.repos-empty { font-size: 0.875rem; color: var(--fg-dim); padding: 0.5rem 0; }

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
.select { cursor: pointer; }

.settings-actions { display: flex; justify-content: flex-end; }
.save-button {
  padding: 0.5rem 1.4rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  font-size: 0.95rem;
}
.save-button:hover { background: var(--accent); }
.save-button:disabled { opacity: 0.6; cursor: not-allowed; }

.env-var-list { display: flex; flex-direction: column; gap: 1.5rem; }
.env-var-group { display: flex; flex-direction: column; gap: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border); }
.env-var-group:first-child { padding-top: 0; border-top: none; }
.env-var-group-title { margin: 0; font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; }
.env-var-row { display: flex; flex-direction: column; gap: 0.35rem; }
.env-var-meta { display: flex; flex-direction: column; gap: 0.15rem; }
.env-var-header { display: flex; align-items: center; gap: 0.5rem; }
.env-var-key { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.8rem; background: var(--panel-hi); padding: 0.1rem 0.4rem; border-radius: 4px; color: var(--fg); }
.env-set-badge { font-size: 0.68rem; padding: 0.1rem 0.4rem; border-radius: 4px; background: var(--green-bg); color: var(--accent); font-weight: 500; }
.env-unset-badge { font-size: 0.68rem; padding: 0.1rem 0.4rem; border-radius: 4px; background: var(--panel-hi); color: var(--fg-dim); font-weight: 500; }
.env-var-desc { margin: 0; font-size: 0.75rem; color: var(--fg-dim); }
.env-var-input { max-width: 480px; }
</style>
