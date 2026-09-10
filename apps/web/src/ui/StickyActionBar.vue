<script setup lang="ts">
/**
 * La barra de acciones fija al pie (T9, R3, R4).
 *
 * En un formulario de 40 KB el pie del documento está a diez pantallas de
 * scroll: `Guardar` ahí abajo no es "el último control", es un control que hay
 * que ir a buscar. Bajo `--bp-shell` la acción principal no scrollea.
 *
 * **Reemplaza a la tab bar, no se suma a ella** (R4). Dos barras fijas son
 * 108px en una pantalla de 800 — el 13% del alto gastado en chrome — y además
 * compiten: el pulgar queda entre "guardar" y "cambiar de pantalla". Por eso
 * se anuncia mientras está montada (`useActionBarPresence`) y el shell no
 * dibuja la tab bar. No hace falta empujar el `padding-bottom` del `<main>`:
 * la barra es `sticky`, no `fixed`, así que ya ocupa su lugar en el flujo.
 *
 * Sobre el breakpoint no se fija: en un escritorio el formulario entra, y una
 * barra flotante encima del contenido tapa la última fila sin necesidad.
 */
import { useActionBarPresence } from '@/composables/useActionBar';

useActionBarPresence();

withDefaults(
  defineProps<{
    /** Se dibuja a la izquierda de los botones: qué está sin guardar, o el
     *  error que impide guardar. Sin esto, un `Guardar` deshabilitado no dice
     *  por qué. */
    note?: string;
    /** El `note` describe un problema, no un estado. */
    noteIsError?: boolean;
  }>(),
  { noteIsError: false },
);
</script>

<template>
  <div class="sab">
    <!-- `lead`: lo que va a la izquierda del todo, separado del primario por el
         ancho entero de la barra. Lo usa `FormFooter` para `Eliminar…`: el
         gesto de borrar no puede quedar a un pixel del de guardar. -->
    <div v-if="$slots.lead" class="sab__lead"><slot name="lead" /></div>
    <p v-if="note" class="sab__note" :class="{ 'sab__note--error': noteIsError }">{{ note }}</p>
    <span v-else class="sab__spacer" />
    <div class="sab__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.sab {
  position: sticky;
  bottom: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  /* `--tap-h-lg`: es la fila de la acción principal de la pantalla, y el
     pulgar la busca sin mirar. */
  min-height: var(--tap-h-lg);
  /* `env(safe-area-inset-bottom)` para el gesture bar de un iPhone: sin esto
     el botón queda debajo de la franja del sistema y el toque no llega. */
  padding: 0.5rem 0.75rem calc(0.5rem + env(safe-area-inset-bottom, 0px));
  margin: 0 -0.75rem;
  background: var(--panel);
  border-top: 1px solid var(--border-hi);
}
.sab__note {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.sab__note--error { color: var(--danger); }
.sab__lead {
  flex: 0 0 auto;
  display: flex;
  gap: 0.5rem;
}
.sab__lead > :deep(.btn) { min-height: var(--tap-h-lg); }
/* Sin `note` la barra necesita igual algo que empuje: si no, `lead` y las
   acciones quedan pegados contra el borde izquierdo. */
.sab__spacer { flex: 1 1 auto; }
.sab__actions {
  flex: 0 0 auto;
  display: flex;
  gap: 0.5rem;
  margin-left: auto;
}
.sab__actions > :deep(.btn) { min-height: var(--tap-h-lg); }

/* Bajo --bp-stack los botones toman el ancho completo: es la fila que se toca
   con el pulgar y no hay nada más compitiendo por ese espacio. */
@media (max-width: 640px) {
  .sab { flex-wrap: wrap; }
  /* En 390px `Eliminar` + `Cancelar` + `Guardar` en una fila deja ~110px por
     botón. El destructivo baja a su propia línea, que además es la que menos
     conviene apurar. */
  .sab__lead { order: 3; width: 100%; }
  .sab__lead > :deep(.btn) { flex: 1; }
  .sab__actions { width: 100%; }
  .sab__actions > :deep(.btn) { flex: 1; }
}

/* Sobre --bp-shell no se fija: el formulario entra, y una barra flotante
   taparía la última fila sin necesidad. */
@media (min-width: 768px) {
  .sab {
    position: static;
    margin: 0;
    padding-left: 0;
    padding-right: 0;
    background: none;
  }
  .sab__actions { margin-left: auto; }
}
</style>
