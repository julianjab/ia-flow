<script setup lang="ts">
// CRUD para providers remotos (instancias de apps/agent-host
// registradas contra este server vía POST /api/provider-registrations).
// Un agente los referencia con `provider: remote:<name>` en su
// AgentDefinition — ver apps/server/src/adapters/remote-provider/RemoteAgentProvider.ts.
import { onMounted, reactive, ref } from 'vue';
import axios from 'axios';
import type { RemoteProviderHealth, SystemPromptDef, SystemPromptRef } from '@ia-flow/shared';
import { useServerEvents } from '@/composables/useServerEvents';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import { useToastStore } from '@/stores/toast';
import {
  type ProviderRegistration,
  checkProviderRegistrationHealth,
  createProviderRegistration,
  deleteProviderRegistration,
  listGlobalSystemPrompts,
  listProviderRegistrations,
  updateProviderRegistrationSystemPrompt,
} from './registrations-api';

const toastStore = useToastStore();

const registrations = ref<ProviderRegistration[]>([]);
const loading = ref(false);
const creating = ref(false);
const saving = ref(false);
const availableSysprompts = ref<SystemPromptDef[]>([]);

// 'none' | 'catalog' | 'inline' — mismos tres modos que el picker del editor
// de agentes (SystemPromptsSection.vue), simplificados a una sola selección:
// acá es EL system prompt de este gateway, no una lista concatenable.
type SystemPromptMode = 'none' | 'catalog' | 'inline';
interface SystemPromptDraft {
  mode: SystemPromptMode;
  catalogId: string;
  inlineText: string;
}

function draftFromRef(ref: SystemPromptRef | null): SystemPromptDraft {
  if (!ref) return { mode: 'none', catalogId: '', inlineText: '' };
  if (typeof ref === 'string') return { mode: 'catalog', catalogId: ref, inlineText: '' };
  return { mode: 'inline', catalogId: '', inlineText: ref.text };
}

function refFromDraft(d: SystemPromptDraft): SystemPromptRef | null {
  if (d.mode === 'catalog') return d.catalogId || null;
  if (d.mode === 'inline') return d.inlineText.trim() ? { text: d.inlineText.trim() } : null;
  return null;
}

function systemPromptSummary(ref: SystemPromptRef | null): string {
  if (!ref) return 'Sin system prompt propio';
  if (typeof ref === 'string') {
    const sp = availableSysprompts.value.find((s) => s.id === ref);
    return sp ? `Catálogo: ${sp.name}` : `Catálogo: ${ref} (ya no existe)`;
  }
  return `Inline: ${ref.text.length > 60 ? `${ref.text.slice(0, 60)}…` : ref.text}`;
}

const draft = reactive({ name: '', baseUrl: '', token: '' });
const draftSystemPrompt = reactive<SystemPromptDraft>({
  mode: 'none',
  catalogId: '',
  inlineText: '',
});
const checking = ref<string | null>(null);

const editingSystemPromptFor = ref<string | null>(null);
const editSystemPrompt = reactive<SystemPromptDraft>({
  mode: 'none',
  catalogId: '',
  inlineText: '',
});
const savingSystemPrompt = ref(false);

function startEditSystemPrompt(reg: ProviderRegistration) {
  editingSystemPromptFor.value = reg.id;
  Object.assign(editSystemPrompt, draftFromRef(reg.systemPrompt));
}

function cancelEditSystemPrompt() {
  editingSystemPromptFor.value = null;
}

async function saveSystemPrompt(id: string) {
  savingSystemPrompt.value = true;
  try {
    const updated = await updateProviderRegistrationSystemPrompt(
      id,
      refFromDraft(editSystemPrompt),
    );
    const reg = registrations.value.find((r) => r.id === id);
    if (reg) reg.systemPrompt = updated.systemPrompt;
    toastStore.success('System prompt del gateway actualizado');
    editingSystemPromptFor.value = null;
  } catch (err) {
    toastStore.error(`No se pudo guardar: ${extractError(err)}`);
  } finally {
    savingSystemPrompt.value = false;
  }
}

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

async function loadSystemPrompts() {
  try {
    availableSysprompts.value = await listGlobalSystemPrompts();
  } catch (err) {
    // No bloquea la sección: sin catálogo, el picker sólo ofrece el modo inline.
    toastStore.error(`No se pudo cargar el catálogo de system prompts: ${extractError(err)}`);
  }
}

onMounted(() => {
  void load();
  void loadSystemPrompts();
});

function startNew() {
  creating.value = true;
  draft.name = '';
  draft.baseUrl = '';
  draft.token = '';
  Object.assign(draftSystemPrompt, { mode: 'none', catalogId: '', inlineText: '' });
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
      systemPrompt: refFromDraft(draftSystemPrompt),
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

function remove(id: string) {
  pendingConfirm.value = {
    title: 'Eliminar registración',
    message: `¿Eliminar la registración '${id}'? Cualquier agente con provider: remote:${id} dejará de poder despachar.`,
    confirmLabel: 'Eliminar',
    onConfirm: () => doRemove(id),
  };
}

async function doRemove(id: string) {
  try {
    await deleteProviderRegistration(id);
    toastStore.success('Registración eliminada');
    await load();
  } catch (err) {
    toastStore.error(`No se pudo eliminar: ${extractError(err)}`);
  }
}

/** Confirmación in-app en vez de `confirm()` nativo: los botones del nativo los
 *  pinta el sistema operativo en el idioma del DISPOSITIVO, así que en un
 *  teléfono en inglés el mensaje sale en español con "OK / Cancel" abajo. */
const pendingConfirm = ref<{
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
} | null>(null);

async function runConfirm() {
  const c = pendingConfirm.value;
  if (!c) return;
  pendingConfirm.value = null;
  await c.onConfirm();
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
        <div class="entry-row">
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
              token {{ reg.hasToken ? 'configurado' : 'FALTA' }} · creado {{ new Date(reg.createdAt).toLocaleString('es') }}
              <template v-if="reg.health.checkedAt">
                · sondeado {{ new Date(reg.health.checkedAt).toLocaleTimeString('es') }}
              </template>
            </span>
            <span class="entry-meta entry-sp">{{ systemPromptSummary(reg.systemPrompt) }}</span>
            <span v-if="reg.health.status === 'down'" class="entry-error">
              {{ reg.health.error }} ({{ reg.health.consecutiveFailures }} fallo(s) seguidos)
            </span>
          </div>
          <div class="entry-actions">
            <button type="button" class="btn-secondary" :disabled="checking === reg.id" @click="recheck(reg.id)">
              {{ checking === reg.id ? 'Sondeando…' : 'Probar' }}
            </button>
            <button type="button" class="btn-secondary" @click="startEditSystemPrompt(reg)">
              System prompt
            </button>
            <button type="button" class="btn-danger" @click="remove(reg.id)">Eliminar</button>
          </div>
        </div>

        <div v-if="editingSystemPromptFor === reg.id" class="sp-editor">
          <p class="section-desc">
            Bloque adicional a los que ya arma cada agente — describe cómo correr
            específicamente en <strong>este</strong> gateway. Se antepone al despachar, para
            cualquier agente que use <code>remote:{{ reg.id }}</code>.
          </p>
          <label class="field">
            <span>Modo</span>
            <select v-model="editSystemPrompt.mode">
              <option value="none">Sin system prompt propio</option>
              <option value="catalog" :disabled="!availableSysprompts.length">Del catálogo</option>
              <option value="inline">Texto inline</option>
            </select>
          </label>
          <label v-if="editSystemPrompt.mode === 'catalog'" class="field">
            <span>System prompt del catálogo</span>
            <select v-model="editSystemPrompt.catalogId">
              <option value="" disabled>Elegí uno…</option>
              <option v-for="sp in availableSysprompts" :key="sp.id" :value="sp.id">{{ sp.name }}</option>
            </select>
          </label>
          <label v-if="editSystemPrompt.mode === 'inline'" class="field">
            <span>Texto</span>
            <textarea
              v-model="editSystemPrompt.inlineText"
              rows="4"
              placeholder="Estás corriendo en una VM efímera de CI, sin red de salida…"
            />
          </label>
          <div class="editor-actions">
            <button type="button" class="btn-secondary" @click="cancelEditSystemPrompt">Cancelar</button>
            <button
              type="button"
              class="btn-primary"
              :disabled="savingSystemPrompt"
              @click="saveSystemPrompt(reg.id)"
            >
              {{ savingSystemPrompt ? 'Guardando…' : 'Guardar' }}
            </button>
          </div>
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
      <label class="field">
        <span>System prompt del gateway (opcional)</span>
        <select v-model="draftSystemPrompt.mode">
          <option value="none">Sin system prompt propio</option>
          <option value="catalog" :disabled="!availableSysprompts.length">Del catálogo</option>
          <option value="inline">Texto inline</option>
        </select>
      </label>
      <label v-if="draftSystemPrompt.mode === 'catalog'" class="field">
        <span>System prompt del catálogo</span>
        <select v-model="draftSystemPrompt.catalogId">
          <option value="" disabled>Elegí uno…</option>
          <option v-for="sp in availableSysprompts" :key="sp.id" :value="sp.id">{{ sp.name }}</option>
        </select>
      </label>
      <label v-if="draftSystemPrompt.mode === 'inline'" class="field">
        <span>Texto</span>
        <textarea
          v-model="draftSystemPrompt.inlineText"
          rows="4"
          placeholder="Estás corriendo en una VM efímera de CI, sin red de salida…"
        />
      </label>
      <div class="editor-actions">
        <button type="button" class="btn-secondary" @click="cancel">Cancelar</button>
        <button type="button" class="btn-primary" :disabled="saving" @click="save">
          {{ saving ? 'Registrando…' : 'Registrar' }}
        </button>
      </div>
    </div>
  </section>

    <ConfirmDialog
      :open="!!pendingConfirm"
      :title="pendingConfirm?.title"
      :message="pendingConfirm?.message ?? ''"
      :confirm-label="pendingConfirm?.confirmLabel"
      danger
      @confirm="runConfirm"
      @cancel="pendingConfirm = null"
    />

</template>

<style scoped>
.section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.muted { color: var(--fg-dim); font-size: 0.85rem; }
.entry-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.entry {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-alt);
}
.entry-row { display: flex; gap: 0.75rem; }
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
.entry-sp { font-style: italic; }
.entry-actions { display: flex; flex-direction: column; gap: 0.35rem; }
.sp-editor {
  border-top: 1px solid var(--border);
  padding-top: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
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
.field input,
.field select,
.field textarea {
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.85rem;
  font-family: inherit;
  background: var(--panel);
  color: var(--fg);
}
.field textarea { resize: vertical; }
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

@media (max-width: 768px) {
  /* Un flex sin `wrap`: el botón de la derecha queda fuera de la pantalla y
     empuja la página. Envolver es lo correcto acá — es un encabezado, no una
     tabla cuyas columnas haya que alinear entre filas. */
  .section-head { flex-wrap: wrap; row-gap: 0.35rem; }
  .section-head > * { min-width: 0; }
  /* Tres botones en la columna de acciones ya no entran al lado del texto
     en un teléfono — se apilan abajo, mismo criterio que .section-head. */
  .entry-row { flex-wrap: wrap; row-gap: 0.5rem; }
  .entry-main { min-width: 0; flex-basis: 100%; }
  .entry-actions { flex-direction: row; flex-wrap: wrap; }
}
</style>