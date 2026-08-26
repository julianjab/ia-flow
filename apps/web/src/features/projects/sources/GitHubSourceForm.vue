<script setup lang="ts">
import type { WorkingMarker } from '@ia-flow/shared';
import { computed } from 'vue';

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

const props = defineProps<{ modelValue: GitHubSourceConfig }>();
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
            <input
              :value="marker.field"
              class="ghsf-input"
              placeholder="Working"
              data-testid="working-marker-field"
              @input="patchMarker({ field: ($event.target as HTMLInputElement).value })"
            />
          </label>
          <label class="ghsf-field">
            <span class="ghsf-label">Ocupado</span>
            <input
              :value="marker.on"
              class="ghsf-input"
              :placeholder="markerOnLabels ? '+ia-flow:working' : 'Yes'"
              @input="patchMarker({ on: ($event.target as HTMLInputElement).value })"
            />
          </label>
          <label class="ghsf-field">
            <span class="ghsf-label">Libre</span>
            <input
              :value="marker.off"
              class="ghsf-input"
              :placeholder="markerOnLabels ? '-ia-flow:working' : '(vacío)'"
              @input="patchMarker({ off: ($event.target as HTMLInputElement).value })"
            />
          </label>
        </div>
        <p class="ghsf-hint">
          Un campo propio del board (single-select), o <code>Labels</code> — ahí los valores son
          tokens con signo y <em>Libre</em> es obligatorio.
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
.ghsf-hint { margin: 0; font-size: 0.75rem; color: var(--fg-mute); }
.ghsf-hint--warn { color: var(--warn); }
</style>
