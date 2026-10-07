import type { EventLogEntry, TaskDetail, TraceEntry } from '@ia-flow/shared'
import { type Ref, ref } from 'vue'
import { extractErrorMessage } from '@/composables/extractErrorMessage'
import { getTaskDetail } from '@/features/inbox/api'

// La tarea abierta y su detalle (ejecuciones, eventos, traza), con lo que le llega en vivo.
// Vive dentro del store (`store.ts` la compone). Tres partes: el caché de detalles (qué se pidió
// y cómo terminó), lo que le llega en vivo a la abierta, y cuál está abierta.

export interface DetailState {
  loading: boolean
  error: string | null
  data: TaskDetail | null
}

/** Líneas de traza que se conservan en vivo: una ejecución larga no crece sin tope. */
const TRACE_CAP = 500

/** El detalle de cada tarea pedida, por ref. */
function createDetailCache() {
  const details = ref<Record<string, DetailState>>({})

  function put(ref: string, state: DetailState): void {
    details.value = { ...details.value, [ref]: state }
  }

  async function loadDetail(ref: string, opts: { silent?: boolean } = {}): Promise<void> {
    const prev = details.value[ref]
    put(ref, { loading: !opts.silent || !prev?.data, error: null, data: prev?.data ?? null })
    try {
      put(ref, { loading: false, error: null, data: await getTaskDetail(ref) })
    } catch (err) {
      put(ref, { loading: false, error: extractErrorMessage(err), data: prev?.data ?? null })
    }
  }

  return { details, put, loadDetail }
}

type DetailCache = ReturnType<typeof createDetailCache>

/** Lo que llega por el stream para la tarea abierta: una línea de traza o un evento. */
function createDetailStream(openRef: Ref<string | null>, cache: DetailCache) {
  /** El detalle abierto, si ya cargó. */
  function current(): { ref: string; detail: TaskDetail } | null {
    const ref = openRef.value
    const detail = ref ? cache.details.value[ref]?.data : null
    return ref && detail ? { ref, detail } : null
  }

  function appendTrace(entry: TraceEntry): void {
    const open = current()
    if (!open) return
    const { ref, detail } = open
    const executionId = detail.trace.at(-1)?.execution_id ?? detail.item.execution?.id
    if (executionId && entry.execution_id !== executionId) return
    const trace = [...detail.trace, entry].slice(-TRACE_CAP)
    cache.put(ref, { loading: false, error: null, data: { ...detail, trace } })
  }

  function appendEvent(entry: EventLogEntry): void {
    const open = current()
    if (!open || entry.task_ref !== open.ref) return
    const { ref, detail } = open
    if (detail.events.some((e) => e.id === entry.id)) return
    const events = [...detail.events, entry]
    cache.put(ref, { loading: false, error: null, data: { ...detail, events } })
  }

  return { appendTrace, appendEvent }
}

export function createDetails() {
  const openRef = ref<string | null>(null)
  /** La tarea abierta se ve en grande (el panel de detalle), no sólo en su fila. */
  const expanded = ref(false)
  const cache = createDetailCache()
  const { appendTrace, appendEvent } = createDetailStream(openRef, cache)

  /** Abre una tarea (sin el panel grande) y pide su detalle; ya abierta, no hace nada. */
  function open(ref: string): void {
    if (openRef.value === ref) return
    openRef.value = ref
    void cache.loadDetail(ref)
  }

  function toggle(ref: string): void {
    expanded.value = false
    if (openRef.value === ref) openRef.value = null
    else open(ref)
  }

  /** El detalle completo de una tarea, en grande. Sigue siendo la abierta: lo vivo le llega igual. */
  function expand(ref: string): void {
    open(ref)
    expanded.value = true
  }

  function collapse(): void {
    expanded.value = false
  }

  const { details, loadDetail } = cache
  return {
    openRef,
    expanded,
    details,
    loadDetail,
    open,
    toggle,
    expand,
    collapse,
    appendTrace,
    appendEvent,
  }
}
