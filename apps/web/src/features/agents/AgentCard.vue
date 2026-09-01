<script setup lang="ts">
import { computed } from 'vue';
import type { AgentDefinition } from '@ia-flow/shared';
import EditableCard from '@/ui/EditableCard.vue';

// Tarjeta de un agente dentro de la lista de AgentesSection. La misma pieza
// sirve para los dos contextos (propios y globales read-only) — lo que cambia
// es si se atenúa, no el contenido. La caja, el hover y el área de click los
// pone `EditableCard`, que es la misma en todas las listas editables de la
// app. Los atributos de drag & drop (`draggable`, @dragstart, …) los pone el
// padre y caen sobre el root por fallthrough.
//
// La tarjeta NO tiene acciones, y eso es el diseño y no una omisión:
//
//  - Borrar vive en el detalle (AgentEditorModal), donde se ve exactamente qué
//    agente se está por borrar.
//  - Habilitar/deshabilitar ya no existe. Un agente no declara si corre: desde
//    la migración 059 eso lo decide la REGLA que lo dispara, y el interruptor
//    que quedaba acá no estaba cableado a nada — prometía apagar un agente que
//    ninguna pantalla podía apagar. Para que un agente deje de correr se apaga
//    (o se da de baja en el proyecto) la regla, en Pipeline.
const props = withDefaults(
  defineProps<{
    agent: AgentDefinition;
    /** Se atenúa: la definición se edita en otro ámbito (un global visto desde
     *  un proyecto), o el repo de agentes es de sólo lectura. El click sigue
     *  abriendo el detalle en modo lectura — ver AgentEditorModal. */
    readonly?: boolean;
  }>(),
  { readonly: false },
);

const emit = defineEmits<{ edit: [] }>();

const promptPreview = computed(() =>
  props.agent.prompt.length > 80 ? `${props.agent.prompt.slice(0, 80)}…` : props.agent.prompt,
);

// `provider` puede ser un string plano (el caso de siempre) o un array de
// candidatos (forma nueva, opt-in — ver AgentProviderSchema). El badge
// muestra el string tal cual, o "N providers" para no volcar objetos crudos.
const providerLabel = computed(() => {
  const p = props.agent.provider;
  return Array.isArray(p) ? `${p.length} providers` : p;
});
</script>

<template>
  <EditableCard
    class="agent-card"
    clickable
    :muted="readonly"
    @edit="emit('edit')"
  >
    <div class="agent-id-row">
      <code class="agent-id">{{ agent.id }}</code>
      <span class="agent-provider-badge">{{ providerLabel }}</span>
    </div>
    <div class="agent-detail">
      <span class="agent-detail-label">Prompt</span>
      <code class="agent-detail-value">{{ promptPreview }}</code>
    </div>
  </EditableCard>
</template>

<style scoped>
.agent-card { padding-top: 0.3rem; padding-bottom: 0.3rem; }

.agent-id-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.agent-id {
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  font-weight: 600;
  color: var(--fg);
}
.agent-provider-badge {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  padding: 0 0.4ch;
  border: 1px solid var(--border-mute);
  border-radius: var(--radius-sm);
  background: var(--panel-hi);
  color: var(--accent);
}

.agent-detail {
  display: grid;
  grid-template-columns: 5rem 1fr;
  gap: 0.15rem 0.5rem;
  font-size: var(--fs-micro);
  align-items: baseline;
}
.agent-detail-label { color: var(--fg-dim); }
.agent-detail-value {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-mute);
  word-break: break-all;
}

@media (max-width: 640px) {
  /* La etiqueta "Prompt" se llevaba 5rem de 358: el preview quedaba en ~230px
     y el corte a 80 caracteres ocupaba cuatro líneas igual. Etiqueta arriba,
     texto abajo a lo ancho. */
  .agent-detail { grid-template-columns: 1fr; gap: 0.15rem; }
}
</style>
