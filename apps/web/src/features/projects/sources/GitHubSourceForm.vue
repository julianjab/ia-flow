<script setup lang="ts">
import type { WorkingMarker } from '@ia-flow/shared';
import { computed } from 'vue';
import type { SourceProjectField } from '@/features/projects/sourceApi';
import AutocompleteSelect from '@/ui/AutocompleteSelect.vue';

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

function setMarkerLabel(name: string) {
  const clean = unsign(name);
  patchMarker({ on: clean ? `+${clean}` : '', off: clean ? `-${clean}` : '' });
}

function unsign(token: string): string {
  return token.trim().replace(/^[+\-=]/, '');
}
</script>

<template>
  <div class="ghsf">
    <label class="ghsf-field">
      <span class="ghsf-label">GitHub Project URL</span>
      <input
        v-model="url"
        class="ghsf-input"
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

    <!-- Marca de "agente trabajando": el único guard anti-doble-dispatch que
         sobrevive al proceso. Sin ella el daemon despacha igual — apoyado sólo
         en sus guards en memoria — así que es una decisión del operador, no un
         requisito del board. -->
    <div class="ghsf-marker">
      <label class="ghsf-check">
        <input v-model="markerEnabled" type="checkbox" data-testid="working-marker-toggle" />
        <span class="ghsf-label">Marcar en el board el item que un agente tomó</span>
      </label>

      <template v-if="markerEnabled">
        <div class="ghsf-row">
          <label class="ghsf-field">
            <span class="ghsf-label">Campo</span>
            <select
              v-if="fieldNames.length"
              :value="marker.field"
              class="ghsf-input"
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
              class="ghsf-input"
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
          <label v-if="markerOnLabels" class="ghsf-field ghsf-field--wide">
            <span class="ghsf-label">Label</span>
            <AutocompleteSelect
              :model-value="markerLabel"
              :options="labelOptions"
              placeholder="ia-flow:working"
              empty-text="Ninguna label del board coincide — se crea al aplicarla"
              data-testid="working-marker-label"
              @update:model-value="setMarkerLabel"
            />
          </label>
          <template v-else>
            <label class="ghsf-field">
              <span class="ghsf-label">Ocupado</span>
              <select
                v-if="valueOptions.length"
                :value="marker.on"
                class="ghsf-input"
                @change="patchMarker({ on: ($event.target as HTMLSelectElement).value })"
              >
                <option value="" disabled>— Valor —</option>
                <option v-for="opt in valueOptions" :key="opt" :value="opt">{{ opt }}</option>
              </select>
              <input
                v-else
                :value="marker.on"
                class="ghsf-input"
                placeholder="Yes"
                @input="patchMarker({ on: ($event.target as HTMLInputElement).value })"
              />
            </label>
            <label class="ghsf-field">
              <span class="ghsf-label">Libre</span>
              <!-- Incluye la opción vacía a propósito: "libre" en un
                   single-select es limpiar el campo, no otro valor. -->
              <select
                v-if="valueOptions.length"
                :value="marker.off"
                class="ghsf-input"
                @change="patchMarker({ off: ($event.target as HTMLSelectElement).value })"
              >
                <option value="">(vacío)</option>
                <option v-for="opt in valueOptions" :key="opt" :value="opt">{{ opt }}</option>
              </select>
              <input
                v-else
                :value="marker.off"
                class="ghsf-input"
                placeholder="(vacío)"
                @input="patchMarker({ off: ($event.target as HTMLInputElement).value })"
              />
            </label>
          </template>
        </div>
        <p class="ghsf-hint">
          {{
            markerOnLabels
              ? 'Se aplica al arrancar y se quita al terminar — también en cancel y en los paths de error.'
              : 'Una columna del board. «Libre» vacío = se limpia el campo.'
          }}
        </p>
      </template>
      <p v-else class="ghsf-hint ghsf-hint--warn">
        Sin marca: dos daemons contra este board pueden despachar el mismo issue, y un reinicio
        re-despacha runs que sigan vivos.
      </p>
    </div>
  </div>
</template>

<style scoped>
.ghsf { display: flex; flex-direction: column; gap: 0.35rem; }
.ghsf-field { display: flex; flex-direction: column; gap: 0.35rem; }
.ghsf-label { font-size: 0.85rem; color: var(--fg-mute); font-weight: 500; }
.ghsf-input {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.9rem;
}
.ghsf-link {
  font-size: 0.75rem;
  color: var(--accent);
  text-decoration: none;
  align-self: flex-start;
}
.ghsf-link:hover { text-decoration: underline; }
.ghsf-marker {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);
}
.ghsf-check { display: flex; align-items: center; gap: 0.4rem; cursor: pointer; }
.ghsf-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.ghsf-row .ghsf-field { flex: 1 1 8rem; min-width: 8rem; }
.ghsf-row .ghsf-field--wide { flex: 2 1 16rem; }
.ghsf-hint { margin: 0; font-size: 0.75rem; color: var(--fg-mute); }
.ghsf-hint--warn { color: var(--warn); }
</style>
