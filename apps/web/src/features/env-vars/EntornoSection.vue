<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, onMounted, ref, watch } from 'vue';
import { buildEnvPatch } from '@/features/env-vars/patch';
import { useEnvVarsStore } from '@/features/env-vars/store';
import WebhookStatusCard from '@/features/webhook-status/WebhookStatusCard.vue';
import StickyActionBar from '@/ui/StickyActionBar.vue';
import { useToastStore } from '@/stores/toast';

const envVarsStore = useEnvVarsStore();
const toastStore = useToastStore();

const envDrafts = ref<Record<string, string>>({});
// Copia de los borradores tal como se inicializaron. Es la referencia contra
// la que `buildEnvPatch` decide qué cambió — sin ella, una variable que viene
// del entorno del proceso se re-enviaba y quedaba persistida en la DB (ver el
// comentario de patch.ts). Se re-arma en cada `initEnvDrafts`, así que después
// de guardar (que refetchea) el estado vuelve a quedar limpio.
const envPristine = ref<Record<string, string>>({});

// El túnel sólo sirve si el secreto del webhook está configurado — la tarjeta
// lo avisa en vez de dejarte pegar una URL que responde 503.
const webhookSecretConfigured = computed(
  () => envVarsStore.vars.IA_FLOW_WEBHOOK_SECRET?.isSet ?? false,
);

/**
 * Qué cartel va al lado del nombre de la variable.
 *
 * Existe porque la precedencia (lo guardado acá le gana al ambiente) no es
 * adivinable desde la pantalla: sin esto, alguien que exporta `GITHUB_TOKEN`
 * en su shell —o lo pone en el compose de un deploy— ve "configurada" y no
 * tiene forma de saber que el proceso está corriendo OTRO valor.
 */
function sourceBadge(key: string): { text: string; cls: string; title: string } {
  const state = envVarsStore.vars[key];
  if (!state?.isSet)
    return {
      text: 'no configurada',
      cls: 'env-unset-badge',
      title: 'Ni guardada acá ni presente en el entorno del proceso.',
    };
  // El tag nombra la FUENTE del valor que el proceso está corriendo, en una
  // palabra, y las dos fuentes son igual de válidas: `env` y `bd` van del
  // mismo verde de "configurada". Con el entorno ganando, que un valor venga
  // del `.env` es lo NORMAL — pintarlo de advertencia diría que algo está mal
  // cuando el sistema está haciendo exactamente lo que debe. Lo único que
  // separa los tres estados con valor es el texto y el tooltip.
  const cls = 'env-set-badge';
  if (state.savedButUnused)
    return {
      text: 'env',
      cls,
      title:
        'El valor viene del entorno del proceso y gana. Hay además un valor guardado acá que NO se está aplicando: va a valer el día que la variable salga del entorno. Para que aplique ahora, sacala del .env / del compose y reiniciá.',
    };
  if (state.source === 'env')
    return {
      text: 'env',
      cls,
      title:
        'El valor viene del entorno del proceso (shell, .env, el compose o el runner.yaml del deploy). El entorno gana, así que guardar acá no lo cambia mientras siga definido allá.',
    };
  return {
    text: 'bd',
    cls,
    title: 'Guardada desde esta pantalla, y en uso: el entorno no define esta variable.',
  };
}

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
  envPristine.value = { ...drafts };
}

watch(() => envVarsStore.vars, initEnvDrafts, { deep: true });

async function onSaveEntorno() {
  const patch = buildEnvPatch(envVarsStore.vars, envDrafts.value, envPristine.value);
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
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  }
}

/**
 * Editar es un modo (R11).
 *
 * Un grupo con veinte variables son veinte campos de `--tap-h`: 1804px de
 * formulario que hay que scrollear entero para llegar a `Guardar`, cuando lo
 * que se venía a hacer era mirar si `WOMPI_KEY` está puesta. En lectura cada
 * variable es una línea de `--row-h` —grilla, no blanco táctil, porque no se
 * toca— y son 584px.
 *
 * El modo es POR GRUPO y no global: se viene a tocar las credenciales de
 * GitHub, no las veinte variables del server, y abrir el grupo equivocado no
 * debería costar el alto de los otros seis.
 *
 * Debajo del umbral no hay modo: montar los campos de tres variables no cuesta
 * nada, y el toggle sería un control de más para no ahorrar nada.
 */
const READ_MODE_FROM = 8;
const editingGroups = ref<Set<string>>(new Set());

function isEditing(group: { group: string; keys: string[] }): boolean {
  return group.keys.length <= READ_MODE_FROM || editingGroups.value.has(group.group);
}

function startEditing(group: string) {
  editingGroups.value = new Set([...editingGroups.value, group]);
}

/**
 * Lo que se lee de una variable sin montar su campo.
 *
 * Un secreto se enmascara SIEMPRE — el modo lectura existe para ver de un
 * vistazo qué está configurado, y un token a la vista de un vistazo es
 * exactamente lo que no se quiere. Y `sin configurar` se dice, no se calla
 * (DESIGN_SYSTEM · Ausencia).
 */
function readValue(key: string): string {
  const state = envVarsStore.vars[key];
  if (!state?.isSet) return 'sin configurar';
  if (state.secret || state.kind === 'password') return '••••••••';
  return state.value || '—';
}

/** Cuántas variables tienen cambios sin guardar. Es lo que la barra fija dice
 *  al lado del botón: un `Guardar` solo no informa qué se está por mandar. */
const dirtyCount = computed(
  () => Object.keys(buildEnvPatch(envVarsStore.vars, envDrafts.value, envPristine.value)).length,
);

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
    <!-- Sin `<h2>Variables de entorno</h2>`: la barra de identidad del shell ya
         dice en qué sección estás (R9). La descripción SÍ queda — explica la
         precedencia entorno/BD, que no es adivinable desde la pantalla. -->
    <p class="section-desc">
      Configura las credenciales y opciones del servidor. <strong>El entorno del proceso
      manda</strong> (shell, <code>.env</code>, el compose del deploy): lo que guardes acá se
      aplica cuando el entorno no define esa variable, y queda esperando cuando sí. El tag al
      lado de cada nombre dice cuál de las dos está en uso. Al guardar sólo se envían los
      campos que hayas modificado.
    </p>

    <WebhookStatusCard :secret-configured="webhookSecretConfigured" />

    <div v-if="envVarsStore.loading" class="repos-empty">Cargando…</div>

    <form v-else class="env-var-list" autocomplete="off" @submit.prevent="onSaveEntorno">
      <div v-for="group in envGroups" :key="group.group" class="env-var-group">
        <h3 class="uc-label env-var-group-title">
          {{ group.label }}
          <span class="env-var-group-count">{{ group.keys.length }}</span>
        </h3>

        <!-- Lectura: una línea de --row-h por variable. Lo que se contesta acá
             es "¿está puesta y de dónde sale?", que no necesita un campo. -->
        <template v-if="!isEditing(group)">
          <div v-for="key in group.keys" :key="key" class="env-read">
            <code class="env-read__key">{{ key }}</code>
            <span class="env-read__val">{{ readValue(key) }}</span>
            <span :class="sourceBadge(key).cls" :title="sourceBadge(key).title">{{
              sourceBadge(key).text
            }}</span>
          </div>
          <button
            type="button"
            class="ff-add"
            :data-testid="`env-edit-${group.group}`"
            @click="startEditing(group.group)"
          >
            editar {{ group.keys.length }} variables
          </button>
        </template>

        <template v-else>
          <label v-for="key in group.keys" :key="key" class="ff-row env-var-row">
            <span class="env-var-header">
              <code class="env-var-key">{{ key }}</code>
              <span :class="sourceBadge(key).cls" :title="sourceBadge(key).title">{{
                sourceBadge(key).text
              }}</span>
            </span>
            <span class="ff-hint">{{ envVarsStore.vars[key].description }}</span>

            <input
              v-if="envVarsStore.vars[key].kind === 'password'"
              v-model="envDrafts[key]"
              type="password"
              class="ff-field ff-mono"
              :placeholder="envVarsStore.vars[key].isSet ? 'Dejar en blanco para conservar el valor actual' : 'Introduce el valor…'"
              autocomplete="off"
            />

            <select
              v-else-if="envVarsStore.vars[key].kind === 'select'"
              v-model="envDrafts[key]"
              class="ff-field"
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
              class="ff-field ff-mono"
              :placeholder="envVarsStore.vars[key].label"
            />
          </label>
        </template>
      </div>

      <!-- La acción principal no scrollea (R3): en un formulario de veinte
           variables el pie del documento está a varias pantallas. La barra
           reemplaza a la tab bar bajo --bp-shell (R4). -->
      <StickyActionBar
        :note="dirtyCount ? `${dirtyCount} sin guardar` : 'sin cambios'"
      >
        <button type="submit" class="btn btn--primary" :disabled="envVarsStore.saving || !dirtyCount">
          {{ envVarsStore.saving ? 'Guardando…' : 'Guardar variables' }}
        </button>
      </StickyActionBar>
    </form>
  </section>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
/* Este archivo era el último en v3 entero: la familia mono escrita a mano, radios
   de 6px, un `box-shadow` azul fuera de la paleta y su propio `.save-button`.
   Migrado al kit de campo y a `.btn` — ver "Campos — deuda conocida" en
   DESIGN_SYSTEM.md, que lo listaba nominalmente. */
.repos-empty { font-size: var(--fs-body-sm); color: var(--fg-dim); padding: 0.5rem 0; }

.env-var-list { display: flex; flex-direction: column; gap: 1.25rem; }
.env-var-group {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}
.env-var-group:first-child { padding-top: 0; border-top: none; }
.env-var-group-title {
  display: flex;
  align-items: center;
  gap: 0.5ch;
  margin: 0;
  /* Pegajoso: con siete grupos en una columna se pierde de vista a cuál
     pertenece la variable que se está mirando. */
  position: sticky;
  top: var(--tap-h);
  z-index: 1;
  background: var(--bg);
  padding: 0.25rem 0;
}
.env-var-group-count { color: var(--fg-dimmer); }

/* La fila de LECTURA: --row-h. Es grilla, no blanco táctil (R11). */
.env-read {
  display: flex;
  align-items: center;
  gap: 0.6ch;
  height: var(--row-h);
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.env-read__key { color: var(--info); flex: 0 0 auto; }
.env-read__val {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-dim);
}

.env-var-row { gap: 0.25rem; }
.env-var-header { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.env-var-key {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  background: var(--panel-hi);
  padding: 0.1rem 0.4rem;
  border-radius: var(--radius-sm);
  color: var(--fg);
}
/* Un solo estilo para las dos fuentes: `bd` y `env` son ambas "configurada".
   `cursor: help` porque el detalle de cada estado vive en el tooltip. */
.env-set-badge,
.env-unset-badge {
  font-size: var(--fs-micro);
  padding: 0.1rem 0.4rem;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  flex: 0 0 auto;
}
.env-set-badge { background: var(--green-bg); color: var(--accent); cursor: help; }
.env-unset-badge { background: var(--panel-hi); color: var(--fg-dim); }

@media (max-width: 768px) {
  /* Los nombres de env var son identificadores largos en mono
     (`IA_FLOW_MAX_CONCURRENT_DISPATCHES`) y sin puntos de corte naturales el
     navegador no los parte: el mínimo del texto empuja a todos sus padres.
     `anywhere` es lo único que corta un token sin espacios. */
  .env-var-header,
  .env-var-header * { overflow-wrap: anywhere; }
  /* En lectura, en cambio, la clave NO se parte: la fila mide --row-h y una
     clave partida la volvería de dos líneas. Cede el valor, que se trunca. */
  .env-read__key { overflow: hidden; text-overflow: ellipsis; max-width: 60%; }
}
</style>
