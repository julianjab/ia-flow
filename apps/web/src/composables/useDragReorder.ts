import { ref } from 'vue'

/**
 * Reordenar una lista arrastrando el handle — con mouse, con el dedo o con
 * lápiz, por el mismo camino.
 *
 * ## Por qué no la API de drag de HTML5
 *
 * `draggable="true"` + `dragstart`/`dragover`/`drop` **es de mouse**: en un
 * teléfono esos eventos no se disparan NUNCA. Tocar y mover un elemento
 * `draggable` scrollea la página. Con los `↑`/`↓` borrados —eran dos blancos
 * más haciendo el trabajo del handle— eso dejaba Pipeline, las acciones de una
 * regla y los candidatos de provider **de sólo lectura bajo `--bp-shell`, sin
 * que nada lo dijera**.
 *
 * Pointer Events cubre los tres punteros con un solo código. No hay rama
 * "mobile": hay un gesto.
 *
 * ## Por qué desde el handle y no con long-press
 *
 * Un long-press pelea con el scroll (el navegador no sabe si querés arrastrar o
 * deslizar hasta que pasan ~500ms), tarda medio segundo en dar señal, y es
 * invisible: nada en la pantalla dice que mantener apretado hace algo.
 *
 * El handle ya existe y ya dice "esto se arrastra". Arrancar desde él resuelve
 * las tres cosas de una: el gesto es inmediato, no compite con el scroll porque
 * `touch-action: none` va SÓLO en el handle —el resto de la fila sigue
 * scrolleando— y la afordancia estaba desde antes.
 *
 * ## Lo que no hace
 *
 * No mueve el DOM ni clona la fila: informa qué índice está agarrado y sobre
 * cuál está parado, y la lista dibuja lo que quiera con eso. Mover nodos desde
 * acá pelearía con el render de Vue.
 */

export interface DragReorderOptions {
  /** Se llama al soltar, con los índices de origen y destino. */
  onReorder: (from: number, to: number) => void
  /**
   * El atributo que marca una fila y lleva su índice. La fila lo declara con
   * `:data-drag-index="i"`; el composable lo lee del DOM en vez de recibir la
   * lista, así no necesita conocer los datos.
   */
  indexAttribute?: string
}

export function useDragReorder({
  onReorder,
  indexAttribute = 'data-drag-index',
}: DragReorderOptions) {
  /** Qué fila está agarrada. `null` = no hay gesto en curso. */
  const dragging = ref<number | null>(null)
  /** Sobre qué fila está el puntero ahora. Es lo que dibuja el indicador. */
  const over = ref<number | null>(null)

  function indexUnder(x: number, y: number): number | null {
    // `elementFromPoint` y no los rects de cada fila: la lista puede scrollear
    // durante el gesto, y unos rects medidos al empezar quedarían viejos.
    const el = document.elementFromPoint(x, y)
    const row = el?.closest(`[${indexAttribute}]`)
    if (!row) return null
    const raw = row.getAttribute(indexAttribute)
    const n = raw === null ? Number.NaN : Number(raw)
    return Number.isInteger(n) ? n : null
  }

  function onMove(e: PointerEvent) {
    if (dragging.value === null) return
    // El navegador no debe interpretar el movimiento como scroll ni como
    // selección de texto mientras el gesto está vivo.
    if (e.cancelable) e.preventDefault()
    over.value = indexUnder(e.clientX, e.clientY)
  }

  function detach() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', cancel)
  }

  function finish() {
    const from = dragging.value
    const to = over.value
    dragging.value = null
    over.value = null
    detach()
    if (from !== null && to !== null && from !== to) onReorder(from, to)
  }

  /**
   * `pointercancel` NO reordena.
   *
   * Lo dispara el sistema cuando se lleva el gesto: una llamada entrante, el
   * gesto de volver atrás de iOS, el navegador decidiendo que era un scroll.
   * Tratarlo como un `pointerup` movería la fila a donde el dedo pasó de
   * casualidad — un reordenamiento que nadie pidió y que nadie va a entender.
   */
  function cancel() {
    dragging.value = null
    over.value = null
    detach()
  }

  /** Se cablea al `pointerdown` del handle. */
  function start(index: number, e: PointerEvent) {
    // Sólo el botón principal: un click derecho sobre el handle abre el menú
    // contextual y dejaría el gesto colgado.
    if (e.button !== 0) return
    if (e.cancelable) e.preventDefault()
    dragging.value = index
    over.value = index
    // En `window` y no en el handle: el dedo se sale de un blanco de 44px en el
    // primer centímetro, y con los listeners en el handle el gesto se cortaría
    // ahí. Es también por qué NO se usa `setPointerCapture` — con captura, el
    // `elementFromPoint` devuelve siempre el handle.
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
  }

  return { dragging, over, start, cancel }
}
