<script setup lang="ts">
import type { ConfigSummary } from '@ia-flow/shared';
import { computed, onMounted, ref } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { getConfig } from '@/features/config/api';
import ConfigCatalog from '@/features/config/ConfigCatalog.vue';
import ConfigPipelines from '@/features/config/ConfigPipelines.vue';

// La config que el runner tiene cargada, de sólo lectura: qué pipelines hay y
// cuándo corren, con qué agentes, providers y MCP. Es lo que responde "¿por qué
// esto corre acá?" sin abrir los YAML. Se edita en `.config/`, no acá.

const config = ref<ConfigSummary | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const source = ref<string | null>(null);

async function load() {
  loading.value = true;
  try {
    config.value = await getConfig();
    error.value = null;
  } catch (err) {
    error.value = extractErrorMessage(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const projects = computed(() => config.value?.projects ?? []);
</script>

<template>
  <div class="cfg">
    <div class="cfg__bar">
      <div v-if="projects.length > 1" class="cfg__chips" role="group" aria-label="Proyecto">
        <button type="button" class="cfg__chip" :aria-pressed="source === null" @click="source = null">Todos</button>
        <button
          v-for="p in projects"
          :key="p.id"
          type="button"
          class="cfg__chip mono"
          :aria-pressed="source === p.id"
          @click="source = p.id"
        >
          {{ p.id }}
        </button>
      </div>
      <p class="cfg__note">De sólo lectura: se edita en <span class="mono">.config/</span> del runner.</p>
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">
        {{ loading ? 'leyendo…' : 'Releer' }}
      </button>
    </div>

    <div v-if="error" class="cfg__err" role="alert">
      <p>✕ {{ error }}</p>
      <button type="button" class="btn" @click="load">Reintentar</button>
    </div>
    <p v-else-if="loading && !config" class="cfg__note">· leyendo la config…</p>

    <template v-if="config">
      <ConfigPipelines :pipelines="config.pipelines" :source="source" />
      <ConfigCatalog :config="config" />
    </template>
  </div>
</template>

<style scoped>
.cfg { display: flex; flex-direction: column; gap: 1.25rem; }
.cfg__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; min-height: var(--tap-h); }
.cfg__chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.cfg__chip { min-height: var(--tap-h-sm); padding: 0 0.75rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); color: var(--fg-mute); font-size: var(--fs-body-sm); }
.cfg__chip[aria-pressed='true'] { background: var(--accent); border-color: var(--accent); color: var(--panel); }
.cfg__note { flex: 1 1 12rem; margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); }
.cfg__err { display: flex; flex-direction: column; align-items: flex-start; gap: 0.35rem; padding: 0.75rem; border: 1px solid var(--danger); border-radius: var(--radius); background: var(--red-bg); }
.cfg__err p { margin: 0; color: var(--danger); overflow-wrap: anywhere; }
</style>
