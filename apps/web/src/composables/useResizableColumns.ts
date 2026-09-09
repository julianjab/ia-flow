import { computed, reactive } from 'vue'

/**
 * Columnas de una tabla-grid (`display: grid`) que se pueden angostar o
 * ensanchar arrastrando el borde derecho de su encabezado — mismo gesto de
 * Pointer Events que `useDragReorder`, pero acá el resultado es un ancho en
 * px, no un índice.
 *
 * ## Por qué un ancho por columna, no un ancho de tabla
 *
 * Las tablas de esta app ya declaran su grilla como
 * `grid-template-columns: 16px minmax(0, 1fr) 7ch 13ch …` — una columna fija
 * (el glifo), una flexible (el título, que absorbe lo que sobra) y el resto
 * en `ch`. Sólo hace falta reemplazar esas últimas por un ancho en px que el
 * usuario mueve: la columna flexible se sigue encargando de que la fila nunca
 * desborde ni deje hueco, sin que este composable tenga que saber nada de
 * eso.
 *
 * ## Qué persiste
 *
 * El ancho final de cada columna, en `localStorage`, bajo una key por
 * pantalla (`storageKey`). Un ancho guardado que ya no respeta el mínimo
 * actual de su columna (la definición cambió) se descarta y vuelve al
 * default — nunca se fuerza un valor inválido.
 */

const STORAGE_PREFIX = 'ia-flow:col-widths:'

/** Una columna de ancho fijo o flexible: su track no cambia con el arrastre. */
export interface StaticColumn {
  key: string
  /** El track CSS tal cual, p. ej. `'16px'` o `'minmax(0, 1fr)'`. */
  track: string
}

/** Una columna que el usuario puede angostar/ensanchar. */
export interface ResizableColumn {
  key: string
  defaultWidth: number
  minWidth?: number
}

export type ColumnSpec = StaticColumn | ResizableColumn

function isResizable(col: ColumnSpec): col is ResizableColumn {
  return 'defaultWidth' in col
}

function loadStored(storageKey: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + storageKey)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // localStorage puede estar bloqueado (modo privado) — sin anchos
    // guardados, se arranca de los defaults.
    return {}
  }
}

export function useResizableColumns(storageKey: string, columns: ColumnSpec[]) {
  const stored = loadStored(storageKey)
  const widths = reactive<Record<string, number>>({})
  for (const col of columns) {
    if (!isResizable(col)) continue
    const saved = stored[col.key]
    const min = col.minWidth ?? 0
    widths[col.key] = typeof saved === 'number' && saved >= min ? saved : col.defaultWidth
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(widths))
    } catch {
      // Sin storage, el ancho vive sólo mientras dura la pestaña.
    }
  }

  const gridTemplateColumns = computed(() =>
    columns.map((c) => (isResizable(c) ? `${widths[c.key]}px` : c.track)).join(' '),
  )

  function onMove(key: string, min: number, startX: number, startWidth: number) {
    return (e: PointerEvent) => {
      widths[key] = Math.max(min, Math.round(startWidth + (e.clientX - startX)))
    }
  }

  /** Se cablea al `pointerdown` del handle, al borde derecho de la columna. */
  function startResize(key: string, e: PointerEvent) {
    const col = columns.find((c) => c.key === key)
    if (!col || !isResizable(col)) return
    if (e.button !== 0) return
    if (e.cancelable) e.preventDefault()
    const min = col.minWidth ?? 0
    const move = onMove(key, min, e.clientX, widths[key])
    function stop() {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      persist()
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  return { widths, gridTemplateColumns, startResize }
}
