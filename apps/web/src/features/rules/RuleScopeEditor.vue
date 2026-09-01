<script setup lang="ts">
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue';
import { computed } from 'vue'
import type { ConditionRow } from '@/ui/condition-rows'
import ConditionRowsEditor from '@/ui/ConditionRowsEditor.vue'

// El "sobre qué" de una regla: los cinco filtros que deciden si un evento le
// corresponde. Se extrajo entero y no partido por tamaño porque es UN dominio
// —el ámbito— y todos sus campos comparten la misma semántica de "vacío = sin
// restricción", que es lo que un editor tiene que dejar leer junto.

const props = defineProps<{
  ops: Array<{ value: string; label: string }>
  repoNames?: string[]
  /** Presente = la regla es de un proyecto; ausente = global. */
  projectId?: string | null
}>()

const repoName = defineModel<string>('repoName', { required: true })
const whenRows = defineModel<ConditionRow[]>('whenRows', { required: true })
const whenText = defineModel<string>('whenText', { required: true })
const schedule = defineModel<string>('schedule', { required: true })
// El conector AND/OR viaja DENTRO de la fila (`ConditionRow.logic`) y lo dibuja
// el propio editor entre las dos condiciones que une. Antes venía por un
// `logics: ('and'|'or')[]` paralelo, con la tira de botones en un renglón
// aparte debajo de todas las condiciones — y al serializar, una fila sin campo
// corría los índices y guardaba los conectores contra la condición equivocada.
// Sugerencia, no autoridad: el repo puede no estar cargado todavía en el
// proyecto y la regla igual tiene que poder nombrarlo.
const repoOptions = computed<ComboOption[]>(() =>
  (props.repoNames ?? []).map((value) => ({ value })),
);
</script>

<template>
  <section class="rse-sec">
    <h3 class="rse-sec-title">Sobre qué</h3>
    <p class="ff-hint rse-scope">
      <template v-if="projectId">
        Se aplica sólo a eventos del proyecto <code>{{ projectId }}</code>.
      </template>
      <template v-else>
        Regla global: ve eventos de cualquier proyecto, y es la única clase que ve un evento
        sin proyecto asignado.
      </template>
    </p>

    <!-- `div` y no `label`: un `<label>` reenvía el click de cualquier
         descendiente a su PRIMER control, y en un ComboBox con chips ése es la
         ✕ del primer chip. Ver el comentario en `ui/ComboBox.vue`. -->
    <div v-if="projectId" class="rse-row">
      <span class="uc-label">Repo</span>
      <ComboBox
        allow-custom
        class="ff-combo"
        :model-value="repoName"
        :options="repoOptions"
        placeholder="cualquiera"
        empty-text="Ninguno del proyecto coincide — se guarda igual"
        @update:model-value="(v) => (repoName = Array.isArray(v) ? (v[0] ?? '') : v)"
      />
      <span class="ff-hint">Vacío = sin restricción. Con valor, exige proyecto Y repo.</span>
    </div>

    <div class="rse-row">
      <span class="uc-label">Condiciones</span>
      <ConditionRowsEditor
        v-model="whenRows"
        logic
        :ops="ops"
        field-placeholder="p. ej. status"
        value-placeholder="valor"
        :op-takes-value="(op: string) => op !== '$null' && op !== '$not_null'"
      />
      <span class="ff-hint">
        Se evalúan contra el payload del evento, incluyendo caminos anidados
        (<code>pr.head.ref</code>).
      </span>
    </div>

    <label class="rse-row">
      <span class="uc-label">Cron</span>
      <input v-model="schedule" class="ff-field ff-mono" placeholder="0 9 * * 1" />
      <span class="ff-hint">
        Opcional. Hace tickear la regla sola — usalo con
        <code>schedule.tick</code> en los tipos de evento. Cinco campos,
        comodines, listas y pasos (<code>*/15 * * * *</code>).
      </span>
    </label>

    <label class="rse-row">
      <span class="uc-label">Criterio en texto libre</span>
      <input v-model="whenText" class="ff-field" placeholder="el PR toca la capa de pagos" />
      <span class="ff-hint">Opcional. Un modelo lee el evento y decide si cumple.</span>
    </label>
  </section>
</template>

<style scoped src="@/ui/form-fields.css"></style>
<style scoped>
.rse-sec {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.rse-sec-title {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-mute);
  margin: 0;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.2rem;
}

/* La caja de un campo es `.ff-row` del kit; acá sólo lo que es de esta
   sección. `.rse-scope` es un párrafo, no un hint de campo: hereda la
   tipografía de `.ff-hint` y sólo agrega su propio margen. */
.rse-row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.rse-scope {
  margin-bottom: 0.2rem;
}
</style>
