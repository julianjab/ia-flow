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
    /** Número mostrado a la izquierda (posición de evaluación). null = sin número. */
    order?: number | null;
    /** Globales vistos desde un proyecto: ni click, ni acciones. */
    readonly?: boolean;
    /** Muestra el badge de scope 'global'. */
    showScopeBadge?: boolean;
    /** Deshabilitado: se atenúa y no ofrece reordenar. */
    disabled?: boolean;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    /** Marca visual mientras se arrastra esta tarjeta. */
    dragging?: boolean;
    /** Marca visual de la posición donde caería la tarjeta arrastrada. */
    dropTarget?: boolean;
  }>(),
  {
    order: null,
    readonly: false,
    showScopeBadge: false,
    disabled: false,
    canMoveUp: false,
    canMoveDown: false,
    dragging: false,
    dropTarget: false,
  },
);

const emit = defineEmits<{
  edit: [];
  delete: [];
  toggle: [];
  move: [direction: -1 | 1];
}>();

const conditionCount = computed(() => {
  const when = props.agent.when;
  if (!when) return 0;
  return Array.isArray(when) ? when.length : Object.keys(when).length;
});

const promptPreview = computed(() =>
  props.agent.prompt.length > 80 ? `${props.agent.prompt.slice(0, 80)}…` : props.agent.prompt,
);

const sortable = computed(() => !props.readonly && !props.disabled);
</script>

<template>
  <div
    class="agent-card"
    :class="{
      'agent-card--global': readonly,
      'agent-card--off': disabled,
      'agent-card--dragging': dragging,
      'agent-card--drop': dropTarget,
    }"
    @click="!readonly && emit('edit')"
  >
    <div class="agent-card-top">
      <div class="agent-id-row">
        <span v-if="sortable" class="agent-drag-handle" aria-hidden="true" title="Arrastra para reordenar">⠿</span>
        <span v-if="order != null" class="agent-order">#{{ order }}</span>
        <code class="agent-id">{{ agent.id }}</code>
        <span class="agent-provider-badge">{{ agent.provider }}</span>
        <span v-if="showScopeBadge" class="agent-scope-badge">global</span>
        <span v-if="agent.enabled === false" class="agent-badge agent-badge--off">deshabilitado</span>
        <span v-if="agent.statusName" class="agent-badge">status: {{ agent.statusName }}</span>
        <span v-if="agent.repoName" class="agent-badge">repo: {{ agent.repoName }}</span>
        <span v-if="conditionCount" class="agent-badge">{{ conditionCount }} condición(es)</span>
      </div>
      <div v-if="!readonly" class="agent-actions">
        <template v-if="!disabled">
          <button
            type="button"
            class="btn-move"
            :disabled="!canMoveUp"
            title="Subir"
            @click.stop="emit('move', -1)"
          >▲</button>
          <button
            type="button"
            class="btn-move"
            :disabled="!canMoveDown"
            title="Bajar"
            @click.stop="emit('move', 1)"
          >▼</button>
        </template>
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
  cursor: default;
  background: var(--panel-alt);
  opacity: 0.85;
}
.agent-card--global:hover {
  border-color: var(--border);
  box-shadow: none;
  background: var(--panel-alt);
}
.agent-card--off { opacity: 0.6; border-style: dashed; }
.agent-card--off:hover { opacity: 0.85; }
.agent-card--dragging { opacity: 0.35; }
.agent-card--drop { border-color: var(--accent); box-shadow: inset 0 2px 0 0 var(--accent); }

.agent-card-top { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.agent-id-row { display: flex; align-items: center; gap: 0.5rem; flex: 1; flex-wrap: wrap; }
.agent-drag-handle {
  color: var(--fg-dim);
  font-size: 0.9rem;
  cursor: grab;
  flex-shrink: 0;
  line-height: 1;
}
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
.agent-order {
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  font-family: var(--font-mono);
  flex-shrink: 0;
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
.btn-move {
  padding: 0 0.4rem;
  height: var(--row-h);
  border: 1px solid var(--border-hi);
  background: var(--panel);
  color: var(--fg-mute);
  font-size: var(--fs-micro);
  cursor: pointer;
  line-height: 1;
}
.btn-move:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn-move:disabled { opacity: 0.4; cursor: not-allowed; }
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
</style>
