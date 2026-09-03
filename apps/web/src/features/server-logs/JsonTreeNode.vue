<script setup lang="ts">
// Se llama a sí mismo (Vue registra un `<script setup>` bajo el nombre de su
// archivo automáticamente) por cada valor-objeto hijo — es lo que reemplaza
// a la lista plana de paths con padding calculado: acá la sangría la da la
// jerarquía REAL de componentes, así un `extras.rejected` (hijo directo de
// `extras`) y un `extras.scope` quedan al mismo nivel, y `extras.scope.issueId`
// un nivel más adentro — sin eso, "algunos campos se ven mal identados" era
// inevitable: una lista de paths no puede mostrar qué campos son hermanos.
import { hasChildren, formatJsonLeaf, jsonTreeFields } from './json-tree';

const props = defineProps<{
  data: unknown
  path: string
  depth: number
  isColumnActive: (path: string) => boolean
  toggleColumn: (path: string) => void
  openFieldMenu: string | null
  fieldMenuId: (path: string) => string
  toggleFieldMenu: (id: string) => void
  closeMenus: () => void
}>();
</script>

<template>
  <div
    v-for="field in jsonTreeFields(props.data, props.path)"
    :key="field.path"
    class="json-tree-node"
  >
    <div class="detail-field-row">
      <div class="detail-field-menu">
        <button
          type="button"
          class="detail-field-dots"
          title="Opciones del campo"
          :data-testid="`server-logs-field-menu-${field.path}`"
          @click.stop="props.toggleFieldMenu(props.fieldMenuId(field.path))"
        >⋮</button>
        <div
          v-if="props.openFieldMenu === props.fieldMenuId(field.path)"
          class="detail-field-menu-popover"
          @click.stop
        >
          <button
            type="button"
            class="detail-field-menu-item"
            @click="props.toggleColumn(field.path); props.closeMenus()"
          >
            {{ props.isColumnActive(field.path) ? 'Quitar columna' : 'Agregar columna' }}
          </button>
        </div>
      </div>
      <span
        class="detail-field-content"
        :style="{ paddingLeft: `${props.depth * 0.9}rem` }"
      >
        <span class="detail-field-key">"{{ field.key }}"</span><span class="detail-json__colon">:</span>
        <span v-if="!hasChildren(field.value)" class="detail-field-value">{{ formatJsonLeaf(field.value) }}</span>
      </span>
    </div>
    <JsonTreeNode
      v-if="hasChildren(field.value)"
      :data="field.value"
      :path="field.path"
      :depth="props.depth + 1"
      :is-column-active="props.isColumnActive"
      :toggle-column="props.toggleColumn"
      :open-field-menu="props.openFieldMenu"
      :field-menu-id="props.fieldMenuId"
      :toggle-field-menu="props.toggleFieldMenu"
      :close-menus="props.closeMenus"
    />
  </div>
</template>

<style scoped>
.detail-field-row {
  display: flex;
  align-items: center;
  padding: 0.1rem 0;
  white-space: nowrap;
}
/* El "…" vive en esta columna de ancho FIJO — a propósito no dentro del
   contenido indentado: si colgara del key, dos campos a distinta
   profundidad tendrían el botón en una x distinta, que es justo lo que se
   pidió evitar (todos los "…" alineados en una sola columna, como el gutter
   de un editor de código). */
.detail-field-menu { position: relative; flex-shrink: 0; width: 1.5rem; }
.detail-field-content {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  overflow: hidden;
}
.detail-field-key {
  flex-shrink: 0;
  color: var(--info);
}
.detail-json__colon { color: var(--fg-dim); margin-right: 0.4rem; }
.detail-field-value {
  flex: 1;
  min-width: 0;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-field-dots {
  background: none;
  border: none;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0.1rem 0.35rem;
  font-size: 0.9rem;
  line-height: 1;
  font-family: inherit;
}
.detail-field-dots:hover { color: var(--fg); }
.detail-field-menu-popover {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 5;
  background: var(--panel);
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  padding: 0.25rem;
  white-space: nowrap;
}
.detail-field-menu-item {
  background: none;
  border: none;
  text-align: left;
  padding: 0.35rem 0.6rem;
  border-radius: 4px;
  color: var(--fg);
  font-size: var(--fs-body-sm);
  font-family: var(--font-body);
  cursor: pointer;
  width: 100%;
}
.detail-field-menu-item:hover { background: var(--panel-hi); }
</style>
