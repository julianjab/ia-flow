<script setup lang="ts">
// CRUD para providers remotos (instancias de apps/agent-host
// registradas contra este server vía POST /api/provider-registrations).
// Un agente los referencia con `provider: remote:<name>` en su
// AgentDefinition — ver apps/server/src/adapters/remote-provider/RemoteAgentProvider.ts.
import { onMounted, reactive, ref } from 'vue';
import axios from 'axios';
import type { RemoteProviderHealth } from '@ia-flow/shared';
import { useServerEvents } from '@/composables/useServerEvents';
import { useToastStore } from '@/stores/toast';
import {
  type ProviderRegistration,
  checkProviderRegistrationHealth,
  createProviderRegistration,
  deleteProviderRegistration,
  listProviderRegistrations,
} from './registrations-api';

const toastStore = useToastStore();

const registrations = ref<ProviderRegistration[]>([]);
const loading = ref(false);
const creating = ref(false);
const saving = ref(false);

const draft = reactive({ name: '', baseUrl: '', token: '' });
const checking = ref<string | null>(null);

// El server desregistra un remoto apenas su agent-host deja de contestar y avisa
// por WS — sin esto la lista mostraría "OK" hasta el próximo refresh manual,
// que es justo lo que no queremos para un estado que decide elegibilidad.
useServerEvents((msg) => {
  if (msg.type !== 'provider-health') return;
  const { id, health } = msg as { id?: string; health?: RemoteProviderHealth };
  if (!id || !health) return;
  const reg = registrations.value.find((r) => r.id === id);
  if (reg) reg.health = health;
});

function healthLabel(health: RemoteProviderHealth): string {
  if (health.status === 'ok') return 'disponible';
  if (health.status === 'down') return 'caído';
  return 'sin sondear';
}

async function recheck(id: string) {
  checking.value = id;
  try {
    const health = await checkProviderRegistrationHealth(id);
    const reg = registrations.value.find((r) => r.id === id);
    if (reg) reg.health = health;
    if (health.status === 'ok') toastStore.success('AgentHost respondiendo — provider disponible');
    else toastStore.error(`Sigue caído: ${health.error ?? 'sin respuesta'}`);
  } catch (err) {
    toastStore.error(`No se pudo sondear: ${extractError(err)}`);
  } finally {
    checking.value = null;
  }
}

function extractError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    return data?.error ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

async function load() {
  loading.value = true;
  try {
    registrations.value = await listProviderRegistrations();
  } catch (err) {
    toastStore.error(`No se pudieron cargar los providers remotos: ${extractError(err)}`);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function startNew() {
  creating.value = true;
  draft.name = '';
  draft.baseUrl = '';
  draft.token = '';
}

function cancel() {
  creating.value = false;
}

async function save() {
  if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.token.trim()) {
    toastStore.error('name, baseUrl y token son requeridos');
    return;
  }
  saving.value = true;
  try {
    await createProviderRegistration({
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      token: draft.token.trim(),
    });
    toastStore.success('Provider remoto registrado');
    creating.value = false;
    await load();
  } catch (err) {
    toastStore.error(`No se pudo registrar: ${extractError(err)}`);
  } finally {
    saving.value = false;
  }
}

async function remove(id: string) {
  if (!confirm(`¿Eliminar la registración '${id}'? Cualquier agente con provider: remote:${id} dejará de poder despachar.`)) return;
  try {
    await deleteProviderRegistration(id);
    toastStore.success('Registración eliminada');
    await load();
  } catch (err) {
    toastStore.error(`No se pudo eliminar: ${extractError(err)}`);
  }
}
</script>

<template>
  <section class="settings-section">
    <header class="section-head">
      <div>
        <h2>Providers remotos</h2>
        <p class="section-desc">
          Instancias de <code>apps/agent-host</code> registradas contra este server —
          self-registradas al bootear o dadas de alta a mano acá. Un agente los usa con
          <code>provider: remote:&lt;name&gt;</code>.
        </p>
        <p class="section-desc">
          Un remoto sólo es <strong>elegible</strong> mientras su agent-host conteste: el server lo
          sondea cada 30s y lo saca de la lista de providers apenas deja de hacerlo (los agentes
          que lo declaran difieren sus issues hasta que vuelve). Acá se sigue viendo la
          registración aunque esté caída — es donde se ve por qué desapareció.
        </p>
        <p class="section-desc">
          Su tope de runs en paralelo no se configura acá: lo lleva el agent-host
          (<code>AGENT_HOST_MAX_CONCURRENT_RUNS</code>), que es el único que ve su ocupación real —
          puede estar registrado en varios servers. Este engine se lo pregunta antes de mandarle
          trabajo y difiere el issue si responde que está al tope.
        </p>
      </div>
      <button type="button" class="btn-primary" @click="startNew">+ Registrar</button>
    </header>

    <p v-if="loading" class="muted">Cargando…</p>

    <ul v-if="!loading && registrations.length" class="entry-list">
      <li v-for="reg in registrations" :key="reg.id" class="entry">
        <div class="entry-main">
          <div class="entry-head">
            <span class="entry-id">remote:{{ reg.id }}</span>
            <span class="entry-name">{{ reg.remoteName }}</span>
            <span class="entry-kind">{{ reg.remoteKind }}</span>
            <span class="entry-health" :class="`health-${reg.health.status}`">
              {{ healthLabel(reg.health) }}
            </span>
          </div>
          <p class="entry-desc">{{ reg.remoteDescription }}</p>
          <code class="entry-url">{{ reg.baseUrl }}</code>
          <span class="entry-meta">
            token {{ reg.hasToken ? 'configurado' : 'FALTA' }} · creado {{ new Date(reg.createdAt).toLocaleString() }}
            <template v-if="reg.health.checkedAt">
              · sondeado {{ new Date(reg.health.checkedAt).toLocaleTimeString() }}
            </template>
          </span>
          <span v-if="reg.health.status === 'down'" class="entry-error">
            {{ reg.health.error }} ({{ reg.health.consecutiveFailures }} fallo(s) seguidos)
          </span>
        </div>
        <div class="entry-actions">
          <button type="button" class="btn-secondary" :disabled="checking === reg.id" @click="recheck(reg.id)">
            {{ checking === reg.id ? 'Sondeando…' : 'Probar' }}
          </button>
          <button type="button" class="btn-danger" @click="remove(reg.id)">Eliminar</button>
        </div>
      </li>
    </ul>
    <p v-else-if="!loading" class="muted">Sin providers remotos registrados todavía.</p>

    <div v-if="creating" class="editor">
      <h3>Nuevo provider remoto</h3>
      <label class="field">
        <span>Name (slug — se usa como <code>remote:&lt;name&gt;</code> y como id)</span>
        <input v-model="draft.name" placeholder="julianbuitrago-mac" />
      </label>
      <label class="field">
        <span>Base URL (alcanzable desde este server)</span>
        <input v-model="draft.baseUrl" placeholder="http://host.containers.internal:3002" />
      </label>
      <label class="field">
        <span>Token (API_AI_PROVIDER_TOKEN del agent-host)</span>
        <input v-model="draft.token" type="password" placeholder="•••" />
      </label>
      <div class="editor-actions">
        <button type="button" class="btn-secondary" @click="cancel">Cancelar</button>
        <button type="button" class="btn-primary" :disabled="saving" @click="save">
          {{ saving ? 'Registrando…' : 'Registrar' }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-section { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0; font-size: 0.82rem; color: var(--fg-dim); line-height: 1.5; }
.section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.muted { color: var(--fg-dim); font-size: 0.85rem; }
.entry-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.entry {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-alt);
}
.entry-main { flex: 1; display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
.entry-head { display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; }
.entry-id { font-family: monospace; font-weight: 600; color: var(--info); }
.entry-name { font-weight: 500; color: var(--fg); }
.entry-kind { font-size: 0.72rem; color: var(--fg-dim); border: 1px solid var(--border); border-radius: 4px; padding: 0 0.3rem; }
.entry-desc { margin: 0; font-size: 0.8rem; color: var(--fg-mute); }
.entry-health { font-size: 0.72rem; border: 1px solid currentColor; padding: 0 0.3rem; }
.health-ok { color: var(--ok, var(--info)); }
.health-down { color: var(--danger); }
.health-unknown { color: var(--fg-dim); }
.entry-error { font-size: 0.72rem; color: var(--danger); }
.entry-url {
  font-size: 0.75rem;
  color: var(--fg-dim);
  background: var(--panel-hi);
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
  width: fit-content;
}
.entry-meta { font-size: 0.72rem; color: var(--fg-dim); }
.entry-actions { display: flex; flex-direction: column; gap: 0.35rem; }
.editor {
  border: 1px solid var(--border-hi);
  border-radius: 8px;
  padding: 1rem;
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.editor h3 { margin: 0; font-size: 1rem; }
.field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: var(--fg-mute); }
.field input {
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.85rem;
}
.editor-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
.btn-primary {
  padding: 0.4rem 0.9rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
}
.btn-primary:hover { background: var(--accent); }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-secondary {
  padding: 0.4rem 0.8rem;
  background: var(--panel);
  color: var(--fg-mute);
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.8rem;
}
.btn-secondary:hover { background: var(--panel-alt); }
.btn-danger {
  padding: 0.4rem 0.8rem;
  background: var(--panel);
  color: var(--danger);
  border: 1px solid var(--danger);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.8rem;
}
.btn-danger:hover { background: var(--red-bg); }
</style>
