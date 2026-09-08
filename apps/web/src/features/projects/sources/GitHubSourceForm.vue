<script setup lang="ts">
import type { WorkingMarker } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';
import { formatGithubRepoUrl, parseGithubRepoRef } from '@/composables/parseGithubRepoRef';
import type { SourceProjectField } from '@/features/projects/sourceApi';
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue';

// Config shape for source.kind === 'github'. Kept flat + typed here rather
// than shared/, since shared is provider-agnostic (see SourceRefSchema).
export interface GitHubSourceConfig {
  url?: string;
  // Cómo se marca en el board que un agente ya tomó un item. Tri-estado:
  //   · undefined → el default del source (`Working` = `Yes`)
  //   · null      → sin marca
  //   · objeto    → el campo/valores que declaró el operador
  // Ver WorkingMarkerSchema en @ia-flow/shared y working-marker.ts en
  // @ia-flow/issue-sources.
  workingMarker?: WorkingMarker | null;
  // Opcional: además del board, vigilar un repo puntual como `github-issues`
  // (ex kind 'github-hybrid' — createDefaultSourceFactory compone las dos
  // fuentes cuando owner+repo están presentes). Sin ellos este source queda
  // como un GitHub Projects liso, igual que siempre.
  owner?: string;
  repo?: string;
  anchorLabel?: string;
}

const DEFAULT_MARKER: WorkingMarker = { field: 'Working', on: 'Yes', off: '' };

const props = defineProps<{
  modelValue: GitHubSourceConfig;
  /** Campos que la fuente publica (`GET /source/fields`) — el mismo catálogo
   *  del editor de outcomes y del de `when`. Vacío ⇒ input libre. */
  sourceFields?: SourceProjectField[];
}>();
const emit = defineEmits<{ 'update:modelValue': [value: GitHubSourceConfig] }>();

const url = computed({
  get: () => props.modelValue.url ?? '',
  set: (v: string) => emit('update:modelValue', { ...props.modelValue, url: v }),
});

// ─── Repo vinculado (opcional, ex 'github-hybrid') ──────────────────────────
// Mismo patrón de GitHubIssuesSourceForm: se pega la URL del repo y se
// deriva owner/repo — el config guardado no persiste la URL, se re-arma al
// abrir el form.
const repoUrl = ref(formatGithubRepoUrl(props.modelValue));
const parsedRepo = computed(() => parseGithubRepoRef(repoUrl.value));
const lastEmittedRepo = ref(`${props.modelValue.owner ?? ''}/${props.modelValue.repo ?? ''}`);

watch(
  () => `${props.modelValue.owner ?? ''}/${props.modelValue.repo ?? ''}`,
  (incoming) => {
    if (incoming === lastEmittedRepo.value) return;
    lastEmittedRepo.value = incoming;
    repoUrl.value = formatGithubRepoUrl(props.modelValue);
  },
);

function onRepoUrlInput(e: Event) {
  repoUrl.value = (e.target as HTMLInputElement).value;
  const next = parsedRepo.value;
  lastEmittedRepo.value = `${next?.owner ?? ''}/${next?.repo ?? ''}`;
  emit('update:modelValue', {
    ...props.modelValue,
    owner: next?.owner || undefined,
    repo: next?.repo || undefined,
  });
}

const anchorLabel = computed({
  get: () => props.modelValue.anchorLabel ?? '',
  set: (v: string) => emit('update:modelValue', { ...props.modelValue, anchorLabel: v }),
});

// `undefined` es "no declarado" y vale el default del source — por eso el
// checkbox está prendido salvo que el valor sea explícitamente `null`.
const marker = computed(() => props.modelValue.workingMarker ?? DEFAULT_MARKER);
const markerEnabled = computed({
  get: () => props.modelValue.workingMarker !== null,
  set: (on: boolean) =>
    emit('update:modelValue', {
      ...props.modelValue,
      workingMarker: on ? { ...marker.value } : null,
    }),
});

function patchMarker(patch: Partial<WorkingMarker>) {
  emit('update:modelValue', {
    ...props.modelValue,
    workingMarker: { ...marker.value, ...patch },
  });
}

// `Labels` no es una columna del board: sus valores son tokens con signo que
// se resuelven contra las labels vigentes, así que sacar la marca necesita un
// `-token` explícito — un `off` vacío la dejaría puesta para siempre.
const markerOnLabels = computed(() => marker.value.field.trim().toLowerCase() === 'labels');

// `Status` no se ofrece: `applyTransition` ya lo escribe en cada outcome, y el
// server rechaza esa combinación al guardar (parseWorkingMarker). Mejor no
// ponerla en la lista que dejar que el 400 sea la explicación.
const fieldNames = computed(() =>
  (props.sourceFields ?? [])
    .map((f) => f.name)
    .filter((n) => n.toLowerCase() !== 'status'),
);

// Opciones del campo elegido. En multi-valor no aplican: el valor no es una
// opción sino una operación sobre el set (`+a` / `-a`), así que ahí va texto.
const valueOptions = computed(() => {
  if (markerOnLabels.value) return [];
  const field = (props.sourceFields ?? []).find(
    (f) => f.name.toLowerCase() === marker.value.field.trim().toLowerCase(),
  );
  return field?.options ?? [];
});

// Cambiar de campo invalida los valores: son opciones de OTRA columna. Mismo
// criterio que el editor de outcomes al cambiar el campo de una asignación.
function selectField(field: string) {
  emit('update:modelValue', {
    ...props.modelValue,
    workingMarker: { field, on: '', off: '' },
  });
}

// ─── Marca sobre `Labels` ────────────────────────────────────────────────
// El campo es multi-valor, pero LA MARCA es una sola label: puesta = ocupado,
// sacada = libre. Así que se elige UNA y el form deriva los dos tokens
// (`+x` / `-x`) — pedirlos escritos a mano invita justo a los dos errores que
// rompen el ciclo: un `off` vacío (la marca no se saca nunca) y dos labels
// distintas en on/off.
const labelOptions = computed(
  () =>
    (props.sourceFields ?? []).find((f) => f.name.toLowerCase() === 'labels')?.options ?? [],
);

const markerLabel = computed(() => unsign(marker.value.on));

// El catálogo de `Labels` son las labels EN USO en los items del board, así
// que un board que todavía no usa ninguna devuelve una lista vacía. Decir
// "ninguna coincide" ahí es mentir sobre la causa: no hay nada contra qué
// comparar. En los dos casos escribirla igual es lo correcto — GitHub crea la
// label al aplicarla — pero el motivo tiene que leerse distinto.
const labelEmptyText = computed(() =>
  labelOptions.value.length
    ? 'Ninguna label del board coincide — se crea al aplicarla'
    : 'El board todavía no usa ninguna label — escribí el nombre y se crea al aplicarla',
);

function setMarkerLabel(name: string) {
  const clean = unsign(name);
  patchMarker({ on: clean ? `+${clean}` : '', off: clean ? `-${clean}` : '' });
}

function unsign(token: string): string {
  return token.trim().replace(/^[+\-=]/, '');
}
// El ComboBox describe cada opción con un objeto; acá la lista son strings
// pelados y el value ES lo que se muestra.
const comboLabelOptions = computed<ComboOption[]>(() => labelOptions.value.map((value) => ({ value })));
</script>

<template>
  <div class="ghsf">
    <label class="ff-row">
      <span class="uc-label">GitHub Project URL</span>
      <input
        v-model="url"
        class="ff-field"
        placeholder="https://github.com/orgs/xxx/projects/N"
      />
    </label>
    <a
      v-if="url"
      :href="url"
      target="_blank"
      rel="noreferrer noopener"
      class="ghsf-link"
    >
      Abrir en GitHub ↗
    </a>

    <div class="ghsf-repo">
      <label class="ff-row">
        <span class="uc-label">Repo vinculado (opcional)</span>
        <input
          :value="repoUrl"
          class="ff-field"
          placeholder="https://github.com/owner/repo"
          data-testid="linked-repo-url"
          @input="onRepoUrlInput"
        />
        <span v-if="repoUrl && !parsedRepo" class="ff-hint ghsf-hint--warn">
          No parece una URL de repo. Formato: https://github.com/owner/repo
        </span>
        <span v-else class="ff-hint">
          Además de este board, vigila los issues abiertos de ese repo (como GitHub Repo) y los
          mergea por issue — dejalo vacío para un GitHub Projects liso.
        </span>
      </label>
      <label v-if="parsedRepo" class="ff-row">
        <span class="uc-label">Anchor label</span>
        <input v-model="anchorLabel" class="ff-field" placeholder="ia-flow" />
        <span class="ff-hint">
          Opcional: sólo los issues con esta label entran al scan. Vacío = todo issue abierto del
          repo es candidato.
        </span>
      </label>
    </div>

    <!-- Marca de "agente trabajando": el único guard anti-doble-dispatch que
         sobrevive al proceso. Sin ella el daemon despacha igual — apoyado sólo
         en sus guards en memoria — así que es una decisión del operador, no un
         requisito del board. -->
    <div class="ghsf-marker">
      <label class="ff-check">
        <input v-model="markerEnabled" type="checkbox" data-testid="working-marker-toggle" />
        <span class="uc-label">Marcar en el board el item que un agente tomó</span>
      </label>

      <template v-if="markerEnabled">
        <div class="ghsf-row">
          <label class="ff-row">
            <span class="uc-label">Campo</span>
            <select
              v-if="fieldNames.length"
              :value="marker.field"
              class="ff-field"
              data-testid="working-marker-field"
              @change="selectField(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>— Campo —</option>
              <option v-for="fn in fieldNames" :key="fn" :value="fn">{{ fn }}</option>
              <!-- Un campo guardado que el board ya no publica no se pierde de
                   vista: se ofrece marcado para que se vea por qué la marca
                   dejó de escribirse. -->
              <option
                v-if="marker.field && !fieldNames.includes(marker.field)"
                :value="marker.field"
              >{{ marker.field }} (no está en el board)</option>
            </select>
            <input
              v-else
              :value="marker.field"
              class="ff-field"
              placeholder="Working"
              data-testid="working-marker-field"
              @input="patchMarker({ field: ($event.target as HTMLInputElement).value })"
            />
          </label>
          <!-- Sobre `Labels` la marca es UNA label: puesta = ocupado, sacada =
               libre. Un solo control, y los tokens con signo los deriva el
               form. Autocomplete y no <select>: una label que todavía no
               existe en el board (la que va a crear el propio agente) tiene
               que poder escribirse. -->
          <label v-if="markerOnLabels" class="ff-row ghsf-field--wide">
            <span class="uc-label">Label</span>
            <ComboBox
              allow-custom
              :model-value="markerLabel"
              :options="comboLabelOptions"
              placeholder="ia-flow:working"
              :empty-text="labelEmptyText"
              data-testid="working-marker-label"
              @update:model-value="(v) => setMarkerLabel(Array.isArray(v) ? (v[0] ?? '') : v)"
            />
          </label>
          <template v-else>
            <label class="ff-row">
              <span class="uc-label">Ocupado</span>
              <select
                v-if="valueOptions.length"
                :value="marker.on"
                class="ff-field"
                @change="patchMarker({ on: ($event.target as HTMLSelectElement).value })"
              >
                <option value="" disabled>— Valor —</option>
                <option v-for="opt in valueOptions" :key="opt" :value="opt">{{ opt }}</option>
              </select>
              <input
                v-else
                :value="marker.on"
                class="ff-field"
                placeholder="Yes"
                @input="patchMarker({ on: ($event.target as HTMLInputElement).value })"
              />
            </label>
            <label class="ff-row">
              <span class="uc-label">Libre</span>
              <!-- Incluye la opción vacía a propósito: "libre" en un
                   single-select es limpiar el campo, no otro valor. -->
              <select
                v-if="valueOptions.length"
                :value="marker.off"
                class="ff-field"
                @change="patchMarker({ off: ($event.target as HTMLSelectElement).value })"
              >
                <option value="">(vacío)</option>
                <option v-for="opt in valueOptions" :key="opt" :value="opt">{{ opt }}</option>
              </select>
              <input
                v-else
                :value="marker.off"
                class="ff-field"
                placeholder="(vacío)"
                @input="patchMarker({ off: ($event.target as HTMLInputElement).value })"
              />
            </label>
          </template>
        </div>
        <p class="ff-hint">
          {{
            markerOnLabels
              ? 'Se aplica al arrancar y se quita al terminar — también en cancel y en los paths de error.'
              : 'Una columna del board. «Libre» vacío = se limpia el campo.'
          }}
        </p>
      </template>
      <p v-else class="ff-hint ghsf-hint--warn">
        Sin marca: dos daemons contra este board pueden despachar el mismo issue, y un reinicio
        re-despacha runs que sigan vivos.
      </p>
    </div>
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
/* Los campos son del kit. Lo que queda es la estructura de ESTE formulario: la
   fila que parte campos, y los dos bloques separados por hairline (el repo y
   el marcador de trabajo), que son agrupaciones propias del source de GitHub. */
.ghsf { display: flex; flex-direction: column; gap: 0.35rem; }
.ghsf-link {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  /* Navega afuera: se toca (R1). */
  min-height: var(--tap-h);
  font-size: var(--fs-micro);
  color: var(--accent);
  text-decoration: none;
}
.ghsf-link:hover { text-decoration: underline; background: transparent; }
.ghsf-repo,
.ghsf-marker {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);
}
.ghsf-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.ghsf-row > .ff-row { flex: 1 1 8rem; min-width: 8rem; }
.ghsf-row > .ghsf-field--wide { flex: 2 1 16rem; }
.ghsf-hint--warn { color: var(--warn); }

/* Bajo --bp-stack la fila partida se apila: dos campos en 390px dejan ~180px
   cada uno (R5). */
@media (max-width: 640px) {
  .ghsf-row { flex-direction: column; }
}
</style>
