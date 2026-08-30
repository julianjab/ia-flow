<script setup lang="ts">
import { computed } from 'vue';
import type { AgentDefinition } from '@ia-flow/shared';

// Tarjeta de un agente dentro de la lista de AgentesSection. La misma pieza
// sirve para los tres contextos (propios activos, propios deshabilitados y
// globales read-only) — lo que cambia es qué acciones se ofrecen, no el
// contenido. Los atributos de drag & drop (`draggable`, @dragstart, …) los
// pone el padre y caen sobre el root por fallthrough.
const props = withDefaults(
  defineProps<{
    agent: AgentDefinition;
    /** Sin acciones (editar/eliminar) — pero el click sigue abriendo el detalle
     *  en modo lectura (ver AgentEditorModal). */
    readonly?: boolean;
    /** Muestra el badge de scope 'global'. */
    showScopeBadge?: boolean;
    /** Se atenúa. */
    disabled?: boolean;
  }>(),
  {
    readonly: false,
    showScopeBadge: false,
    disabled: false,
  },
);

const emit = defineEmits<{
  edit: [];
  delete: [];
  toggle: [];
}>();

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
  <div
    class="agent-card"
    :class="{
      'agent-card--global': readonly,
      'agent-card--off': disabled,
    }"
    @click="emit('edit')"
  >
    <div class="agent-card-top">
      <div class="agent-id-row">
        <code class="agent-id">{{ agent.id }}</code>
        <span class="agent-provider-badge">{{ providerLabel }}</span>
        <span v-if="showScopeBadge" class="agent-scope-badge">global</span>
      </div>
      <div v-if="!readonly" class="agent-actions">
        <button
          type="button"
          class="btn-toggle"
          :class="{ 'btn-toggle--on': disabled }"
          :title="disabled ? 'Habilitar agente' : 'Deshabilitar agente'"
          @click.stop="emit('toggle')"
        >{{ disabled ? 'Habilitar' : 'Deshabilitar' }}</button>
        <button type="button" class="btn-delete" title="Eliminar" @click.stop="emit('delete')">✕</button>
      </div>
    </div>
    <div class="agent-detail">
      <span class="agent-detail-label">Prompt</span>
      <code class="agent-detail-value">{{ promptPreview }}</code>
    </div>
  </div>
</template>

<style scoped>
.agent-card {
  border: 1px solid var(--border);
  padding: 0.75rem 0.9rem;
  background: var(--panel-alt);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s, background 0.12s, opacity 0.12s;
}
.agent-card:hover { border-color: var(--accent); background: var(--panel); }
.agent-card--global {
  cursor: pointer;
  background: var(--panel-alt);
  opacity: 0.85;
}
.agent-card--global:hover {
  border-color: var(--accent);
  background: var(--panel);
}
.agent-card--off { opacity: 0.6; border-style: dashed; }
.agent-card--off:hover { opacity: 0.85; }

.agent-card-top { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.agent-id-row { display: flex; align-items: center; gap: 0.5rem; flex: 1; flex-wrap: wrap; }
.agent-id {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--fg);
}
.agent-provider-badge {
  font-size: 0.68rem;
  padding: 0.1rem 0.45rem;
  background: var(--panel-hi);
  color: var(--accent);
  font-weight: 500;
}
.agent-scope-badge {
  font-size: 0.65rem;
  padding: 0.08rem 0.4rem;
  background: var(--panel-hi);
  color: var(--fg-dim);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.agent-badge {
  font-size: var(--fs-micro);
  padding: 0 0.5ch;
  height: var(--row-h);
  line-height: var(--row-h);
  background: var(--panel-hi);
  color: var(--info);
  border: 1px solid var(--border-mute);
}
.agent-badge--off { color: var(--fg-dim); border-color: var(--fg-dim); }

.agent-actions { display: flex; align-items: center; gap: 0.35rem; flex-shrink: 0; }
.btn-toggle {
  padding: 0 0.5rem;
  height: var(--row-h);
  border: 1px solid var(--border-hi);
  background: var(--panel);
  color: var(--fg-mute);
  font-size: var(--fs-micro);
  cursor: pointer;
  line-height: 1;
  white-space: nowrap;
}
.btn-toggle:hover { border-color: var(--accent); color: var(--accent); }
.btn-toggle--on:hover { border-color: var(--info); color: var(--info); }
.btn-delete {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--danger);
  background: var(--panel);
  color: var(--danger);
  font-size: 0.8rem;
  cursor: pointer;
  line-height: 1;
}
.btn-delete:hover { background: var(--red-bg); }

.agent-detail {
  display: grid;
  grid-template-columns: 5rem 1fr;
  gap: 0.15rem 0.5rem;
  font-size: 0.78rem;
  align-items: baseline;
}
.agent-detail-label { color: var(--fg-dim); }
.agent-detail-value {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--fg);
  word-break: break-all;
}

@media (max-width: 640px) {
  /* El id y el badge del provider ya envuelven, pero las acciones no: con un
     id largo quedaban apretadas contra el borde. Se van a su propia línea. */
  .agent-card-top { flex-wrap: wrap; gap: 0.4rem 0.75rem; }

  /* La etiqueta "Prompt" se llevaba 5rem de 358: el preview quedaba en ~230px
     y el corte a 80 caracteres ocupaba cuatro líneas igual. Etiqueta arriba,
     texto abajo a lo ancho. */
  .agent-detail { grid-template-columns: 1fr; gap: 0.15rem; }
}
</style>
