import { computed, onUnmounted, type Ref, ref } from 'vue'

/**
 * ¿Hay una barra de acciones fija en pantalla? (R4)
 *
 * **Tab bar o barra de acciones, nunca las dos.** Son 108px en una pantalla de
 * 800 —el 13% del alto gastado en chrome— y además compiten: el pulgar queda
 * entre "guardar" y "cambiar de pantalla".
 *
 * `StickyActionBar` documentaba que empujaba el `<main>` con una clase
 * `has-action-bar`, pero esa clase no existía en ninguna parte: el mecanismo
 * nunca se implementó y las dos barras convivían en Entorno y Ejecuciones. Se
 * notó recién cuando `FormFooter` llevó la barra a seis pantallas más.
 *
 * Es un contador y no un booleano porque nada garantiza que haya una sola
 * montada: un formulario que se abre encima de una lista que ya tenía la suya
 * deja dos vivas por un tick, y con un booleano la primera en desmontarse
 * devolvería la tab bar con la otra todavía en pantalla.
 *
 * Vive en `composables/` y no en `ui/` porque lo comparten dos lados que no se
 * pueden importar entre sí: la primitiva que la dibuja y el shell que decide
 * el chrome.
 */
const mounted = ref(0)

/** La llama la barra: se anuncia mientras está montada. */
export function useActionBarPresence(): void {
  mounted.value++
  onUnmounted(() => {
    mounted.value = Math.max(0, mounted.value - 1)
  })
}

/** La lee el shell, para no dibujar la tab bar encima. */
export function useHasActionBar(): { hasActionBar: Ref<boolean> } {
  return { hasActionBar: computed(() => mounted.value > 0) }
}
