<script setup lang="ts">
import type { ConditionRow } from '@/ui/condition-rows'
import ConditionRowsEditor from '@/ui/ConditionRowsEditor.vue'

// El "sobre qué" de una regla: los cinco filtros que deciden si un evento le
// corresponde. Se extrajo entero y no partido por tamaño porque es UN dominio
// —el ámbito— y todos sus campos comparten la misma semántica de "vacío = sin
// restricción", que es lo que un editor tiene que dejar leer junto.

defineProps<{
  ops: Array<{ value: string; label: string }>
  repoNames?: string[]
  /** Presente = la regla es de un proyecto; ausente = global. */
  projectId?: string | null
}>()

const repoName = defineModel<string>('repoName', { required: true })
const whenRows = defineModel<ConditionRow[]>('whenRows', { required: true })
const whenText = defineModel<string>('whenText', { required: true })
const schedule = defineModel<string>('schedule', { required: true })
// `when` viaja como WhenCondition[] pero la fila compartida no conoce `logic`
// (el conector con la anterior). Se preserva por índice en vez de perderse:
// una regla guardada con un OR tiene que volver siendo la misma.
const logics = defineModel<Array<'and' | 'or'>>('logics', { required: true })

function toggleLogic(i: number) {
  const next = [...logics.value]
  next[i] = next[i] === 'or' ? 'and' : 'or'
  logics.value = next
}
</script>

<template>
  <section class="rse-sec">
    <h3 class="rse-sec-title">Sobre qué</h3>
    <p class="rse-scope">
      <template v-if="projectId">
        Se aplica sólo a eventos del proyecto <code>{{ projectId }}</code>.
      </template>
      <template v-else>
        Regla global: ve eventos de cualquier proyecto, y es la única clase que ve un evento
        sin proyecto asignado.
      </template>
    </p>

    <label v-if="projectId" class="rse-row">
      <span class="rse-lbl">Repo</span>
      <select v-if="repoNames?.length" v-model="repoName" class="rse-field">
        <option value="">— cualquiera —</option>
        <option v-for="r in repoNames" :key="r" :value="r">{{ r }}</option>
      </select>
      <input v-else v-model="repoName" class="rse-field rse-mono" placeholder="cualquiera" />
      <span class="rse-hint">Vacío = sin restricción. Con valor, exige proyecto Y repo.</span>
    </label>

    <div class="rse-row">
      <span class="rse-lbl">Condiciones</span>
      <ConditionRowsEditor v-model="whenRows" :ops="ops" value-placeholder="valor" />
      <div v-if="whenRows.length > 1" class="rse-logics">
        <button
          v-for="i in whenRows.length - 1"
          :key="i"
          type="button"
          class="rse-logic"
          :class="logics[i] ?? 'and'"
          @click="toggleLogic(i)"
        >{{ (logics[i] ?? 'and').toUpperCase() }}</button>
      </div>
      <span class="rse-hint">
        Se evalúan contra el payload del evento, incluyendo caminos anidados
        (<code>pr.head.ref</code>).
      </span>
    </div>

    <label class="rse-row">
      <span class="rse-lbl">Cron</span>
      <input v-model="schedule" class="rse-field rse-mono" placeholder="0 9 * * 1" />
      <span class="rse-hint">
        Opcional. Hace tickear la regla sola — usalo con
        <code>schedule.tick</code> en los tipos de evento. Cinco campos,
        comodines, listas y pasos (<code>*/15 * * * *</code>).
      </span>
    </label>

    <label class="rse-row">
      <span class="rse-lbl">Criterio en texto libre</span>
      <input v-model="whenText" class="rse-field" placeholder="el PR toca la capa de pagos" />
      <span class="rse-hint">Opcional. Un modelo lee el evento y decide si cumple.</span>
    </label>
  </section>
</template>

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

.rse-row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.rse-lbl {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.rse-field {
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: var(--panel-alt);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: var(--fs-body-sm);
  width: 100%;
  box-sizing: border-box;
  border-radius: var(--radius-sm);
}
.rse-mono { font-family: var(--font-mono); }

.rse-hint,
.rse-scope {
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  line-height: 1.5;
  margin: 0;
}
.rse-hint code,
.rse-scope code {
  font-family: var(--font-mono);
  color: var(--fg-mute);
}

.rse-logics {
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}
.rse-logic {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  font-weight: 700;
  letter-spacing: var(--tracking-lbl);
  padding: 0 0.4ch;
  height: var(--row-h);
  line-height: var(--row-h);
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--panel-alt);
  border-radius: var(--radius-sm);
}
.rse-logic.and { color: var(--ai); border-color: var(--ai); }
.rse-logic.or { color: var(--warn); border-color: var(--warn); background: var(--yellow-bg); }
</style>
