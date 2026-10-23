<script setup lang="ts">
import { RouterLink, type RouteLocationRaw } from 'vue-router';

/**
 * La tab bar de la capa táctil (bajo `--bp-shell`): los destinos a un toque,
 * fija al pie y pegada a la zona segura. R4: es LA barra fija de la pantalla;
 * un detalle o un formulario que trae su barra de acciones la tapa entera.
 *
 * Un destino es una ruta (`to`) o una acción (`press`, p. ej. abrir el
 * asistente, que es un overlay y no una ruta). El ícono va por el slot
 * `icon`, con la `id` del destino, para que esto no sepa de dominio.
 */
export interface TabItem {
  id: string;
  label: string;
  to?: RouteLocationRaw;
  /** Marca el destino como el actual (para los que no son ruta). */
  active?: boolean;
  /** Un número a atender. En cero no se dibuja (R10). */
  badge?: number;
  /** Algo nuevo sin número (una respuesta sin leer). */
  dot?: boolean;
}

defineProps<{ items: readonly TabItem[] }>();
const emit = defineEmits<{ press: [id: string] }>();
</script>

<template>
  <nav class="tb" aria-label="Secciones">
    <template v-for="item in items" :key="item.id">
      <RouterLink v-if="item.to" :to="item.to" class="tb__item" :data-test="`tab-${item.id}`">
        <span class="tb__ic" aria-hidden="true"><slot name="icon" :id="item.id" /></span>
        <span class="tb__label">{{ item.label }}</span>
        <span v-if="item.badge" class="tb__badge" :aria-label="`${item.badge} pendientes`">{{ item.badge }}</span>
        <span v-else-if="item.dot" class="tb__dot" aria-label="Novedad" />
      </RouterLink>
      <button
        v-else
        type="button"
        class="tb__item"
        :data-test="`tab-${item.id}`"
        :aria-current="item.active ? 'page' : undefined"
        @click="emit('press', item.id)"
      >
        <span class="tb__ic" aria-hidden="true"><slot name="icon" :id="item.id" /></span>
        <span class="tb__label">{{ item.label }}</span>
        <span v-if="item.badge" class="tb__badge" :aria-label="`${item.badge} pendientes`">{{ item.badge }}</span>
        <span v-else-if="item.dot" class="tb__dot" aria-label="Novedad" />
      </button>
    </template>
  </nav>
</template>

<style scoped>
.tb {
  position: fixed;
  inset: auto 0 0;
  z-index: 50;
  display: grid;
  grid-auto-columns: 1fr;
  grid-auto-flow: column;
  padding: 0.2rem max(0.25rem, env(safe-area-inset-right, 0px)) calc(0.2rem + env(safe-area-inset-bottom, 0px)) max(0.25rem, env(safe-area-inset-left, 0px));
  border-top: 1px solid var(--border-mute);
  background: var(--bg);
}
.tb__item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.1rem;
  min-height: var(--tap-h-lg);
  border: 0;
  border-radius: var(--radius);
  background: none;
  color: var(--fg-dim);
  font: inherit;
  cursor: pointer;
}
/* `a:hover` global pinta video inverso: acá no. */
.tb__item:hover { background: transparent; color: var(--fg); }
.tb__item.router-link-exact-active,
.tb__item[aria-current='page'] { color: var(--fg); }
.tb__item.router-link-exact-active .tb__ic,
.tb__item[aria-current='page'] .tb__ic { color: var(--info); }
.tb__ic { display: grid; place-items: center; width: 1.35rem; height: 1.35rem; }
.tb__ic :deep(svg) { width: 100%; height: 100%; }
.tb__label { font-size: var(--fs-micro); }
.tb__badge {
  position: absolute;
  top: 0.2rem;
  left: calc(50% + 0.35rem);
  min-width: 1rem;
  height: 1rem;
  padding: 0 0.25rem;
  border-radius: 0.5rem;
  background: var(--warn);
  color: var(--bg);
  font-size: var(--fs-micro);
  font-weight: 600;
  line-height: 1rem;
  font-variant-numeric: tabular-nums;
}
.tb__dot {
  position: absolute;
  top: 0.35rem;
  left: calc(50% + 0.4rem);
  width: 0.55rem;
  height: 0.55rem;
  border: 2px solid var(--bg);
  border-radius: 50%;
  background: var(--ai);
}
</style>
