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
/** Pipelines o el catálogo (agentes, providers, MCP): una lista a la vez, no dos pantallas apiladas. */
const tab = ref<'pipelines' | 'catalog'>('pipelines');

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
        <button type="button" class="filter-chip cfg__chip" :aria-pressed="source === null" @click="source = null">Todos</button>
        <button
          v-for="p in projects"
          :key="p.id"
          type="button"
          class="filter-chip cfg__chip"
          :aria-pressed="source === p.id"
          @click="source = p.id"
        >
          {{ p.id }}
        </button>
      </div>
    </div>

    <div class="cfg__ro">
      <p class="cfg__note">Es de solo lectura: se edita en <span class="mono">.config/</span> del runner.</p>
      <button type="button" class="btn btn--ghost cfg__reload" :disabled="loading" @click="load">
        {{ loading ? 'Leyendo…' : 'Releer' }}
      </button>
    </div>

    <div v-if="error" class="cfg__err" role="alert">
      <p>✕ {{ error }}</p>
      <button type="button" class="btn" @click="load">Reintentar</button>
    </div>
    <p v-else-if="loading && !config" class="cfg__note">Leyendo la config…</p>

    <template v-if="config">
      <div class="cfg__tabs" role="tablist" aria-label="Qué mirar">
        <button type="button" role="tab" class="cfg__tab" data-test="tab-pipelines" :aria-selected="tab === 'pipelines'" @click="tab = 'pipelines'">
          Pipelines <span class="cfg__n">{{ config.pipelines.length }}</span>
        </button>
        <button type="button" role="tab" class="cfg__tab" data-test="tab-catalog" :aria-selected="tab === 'catalog'" @click="tab = 'catalog'">
          Agentes y providers <span class="cfg__n">{{ config.agents.length }}</span>
        </button>
      </div>
      <ConfigPipelines v-if="tab === 'pipelines'" :pipelines="config.pipelines" :source="source" />
      <ConfigCatalog v-else :config="config" />
    </template>
  </div>
</template>

<style scoped>
.cfg { display: flex; flex-direction: column; gap: 1rem; }
.cfg__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; }
.cfg__bar:empty { display: none; }
.cfg__chips { display: flex; gap: 0.35rem; min-width: 0; overflow-x: auto; scrollbar-width: none; }
/* Solo lectura: un aviso de una línea, con Releer a mano. */
.cfg__ro { display: flex; align-items: center; gap: 0.5rem; padding: 0 0.25rem 0 0.75rem; border: 1px solid var(--border-mute); border-radius: var(--radius); background: var(--panel); }
.cfg__note { flex: 1 1 12rem; margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); }
.cfg__reload { flex: none; }
.cfg__tabs { display: flex; gap: 1.25rem; border-bottom: 1px solid var(--border); }
.cfg__tab { min-height: var(--tap-h); margin-bottom: -1px; padding: 0; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--fg-dim); font: inherit; font-size: var(--fs-body-sm); cursor: pointer; }
.cfg__tab:hover { color: var(--fg); }
.cfg__tab[aria-selected='true'] { border-bottom-color: var(--accent); color: var(--fg); }
.cfg__n { color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.cfg__err { display: flex; flex-direction: column; align-items: flex-start; gap: 0.35rem; padding: 0.75rem; border: 1px solid var(--danger); border-radius: var(--radius); background: var(--red-bg); }
.cfg__err p { margin: 0; color: var(--danger); overflow-wrap: anywhere; }
</style>
