<script setup lang="ts">
/**
 * La barra "Aplicar"/"Descartar" — UNA sola, visible mientras haya una
 * propuesta staged, sin importar si sus acciones caen sobre la barra de
 * comandos (`scope: project`) o dentro de una fila (`scope: task`): el
 * diseño final (10f) la trata como un único control, no uno por fila.
 *
 * En mobile (≤768px) reemplaza la tab-bar mientras está visible (fixed
 * bottom); en desktop va inline, en el encabezado del bloque que la mostró,
 * con el borde de color que la distingue del resto del chrome.
 */
defineProps<{
  actionsCount: number
}>()

defineEmits<{
  apply: []
  discard: []
}>()
</script>

<template>
  <div class="task-action-block" data-testid="chat-action-block">
    <span class="action-summary">
      {{ actionsCount }} {{ actionsCount === 1 ? 'cambio propuesto' : 'cambios propuestos' }}
    </span>
    <div class="action-bar">
      <button type="button" class="btn btn--primary" data-testid="chat-apply" @click="$emit('apply')">
        Aplicar
      </button>
      <button type="button" class="btn btn--ghost" data-testid="chat-discard" @click="$emit('discard')">
        Descartar
      </button>
    </div>
  </div>
</template>

<style scoped>
.task-action-block {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--accent);
  background: var(--panel-alt);
}
.action-summary {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.action-bar { display: flex; gap: 0.5rem; flex: none; }
.action-bar .btn { height: var(--tap-h); padding: 0 0.75rem; font-size: var(--fs-micro); }

/* En mobile, la barra reemplaza la tab-bar mientras hay una propuesta
   abierta: mismo z-index/posición que ese chrome, para no competir con él. */
@media (max-width: 768px) {
  .task-action-block {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    height: var(--tap-h);
    padding: 0 0.75rem;
  }
}
</style>
