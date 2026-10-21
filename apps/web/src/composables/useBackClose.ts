import { onBeforeUnmount, type WatchSource, watch } from 'vue'

/**
 * El «atrás» del sistema cierra lo que está encima (un sheet, el detalle, el asistente) en vez de
 * salir de la pantalla: el gesto de Android, el swipe de iOS y el botón del navegador.
 *
 * Cada overlay abierto suma una entrada al historial, en la misma URL, marcada con su profundidad
 * (`history.state.__overlay`). Un `popstate` que aterriza en una profundidad menor cierra los que
 * quedaron arriba. Cerrar con ✕ (o tocando afuera) consume esa entrada con `history.go(-n)`, para
 * que el siguiente «atrás» no caiga en un overlay que ya no está.
 *
 * Ese `go` es asíncrono: hasta que llega su `popstate`, el historial está «en vuelo». Abrir otro
 * overlay (cerrar el sheet y abrir el detalle en el mismo toque) o navegar con el router en ese
 * lapso lo pisaría: por eso abrir y cerrar pasan por una cola, y el router la espera en su
 * `beforeEach` (`historySettled()`).
 *
 * Un overlay que se desmonta abierto (cambiar de pantalla) suelta su lugar sin tocar el historial:
 * su entrada queda y el «atrás» la pasa de largo.
 */

const KEY = '__overlay'
/** Si el `popstate` de un `go` propio no llega (un navegador raro, un test), no se espera más. */
const SETTLE_TIMEOUT_MS = 400

interface Entry {
  depth: number
  close: () => void
}

const stack: Entry[] = []
/** Profundidades de los overlays cerrados a mano y no consumidas todavía. */
let released: number[] = []
/** Overlays abiertos que todavía no tienen su entrada. */
const pending: Entry[] = []
let queued = false
/** La cola del historial: cada vuelta consume lo cerrado y después empuja lo abierto, en orden. */
let chain: Promise<void> = Promise.resolve()
let inFlight: { resolve: () => void; timer: ReturnType<typeof setTimeout> } | null = null
let listening = false

const hasHistory = () =>
  typeof window !== 'undefined' && typeof window.history?.pushState === 'function'

function depthOf(state: unknown): number {
  const depth = (state as Record<string, unknown> | null)?.[KEY]
  return typeof depth === 'number' ? depth : 0
}

function land() {
  if (!inFlight) return
  clearTimeout(inFlight.timer)
  const { resolve } = inFlight
  inFlight = null
  resolve()
}

function onPopState() {
  if (inFlight) return land()
  // La entrada en la que se aterrizó (lo mismo que `event.state`).
  const depth = depthOf(window.history.state)
  while (stack.length && (stack.at(-1) as Entry).depth > depth) (stack.pop() as Entry).close()
  // Huérfana: la dejó un overlay que se desmontó abierto (se cambió de pantalla). No hay nada que
  // cerrar ahí, así que se sigue de largo hasta lo que sigue abierto (o la pantalla misma).
  const floor = Math.max(0, ...stack.map((e) => e.depth))
  if (depth > floor) chain = chain.then(() => back(depth - floor))
}

function listen() {
  if (listening || !hasHistory()) return
  window.addEventListener('popstate', onPopState)
  listening = true
}

function back(n: number): Promise<void> {
  return new Promise<void>((resolve) => {
    inFlight = { resolve, timer: setTimeout(land, SETTLE_TIMEOUT_MS) }
    window.history.go(-n)
  })
}

/**
 * Una vuelta de la cola. Primero vuelve hasta debajo de la más baja de las cerradas (con las
 * colgadas arriba de ella), pero nunca por debajo de lo que sigue abierto: eso cerraría con el
 * historial algo que nadie cerró. Después empuja una entrada por cada overlay abierto en el tick
 * (cerrar el sheet y abrir el detalle en el mismo toque deja una sola: la del detalle).
 */
async function flush() {
  queued = false
  if (released.length) {
    const lowest = Math.min(...released)
    released = []
    const floor = Math.max(0, ...stack.map((e) => e.depth))
    const n = depthOf(window.history.state) - Math.max(floor, lowest - 1)
    if (n > 0) await back(n)
  }
  for (const entry of pending.splice(0)) {
    // Se cerró mientras esperaba su turno: no hay nada que empujar.
    if (!stack.includes(entry)) continue
    entry.depth = depthOf(window.history.state) + 1
    window.history.pushState({ ...(window.history.state ?? {}), [KEY]: entry.depth }, '')
  }
}

function schedule() {
  if (queued) return
  queued = true
  // Al final del tick: los cierres y aperturas de un mismo toque entran en la misma vuelta.
  chain = chain.then(() => new Promise<void>((resolve) => queueMicrotask(resolve))).then(flush)
}

/** Resuelve cuando la cola del historial quedó quieta: recién ahí se puede empujar una ruta. */
export function historySettled(): Promise<void> {
  return chain
}

function push(close: () => void): Entry {
  const entry: Entry = { depth: 0, close }
  stack.push(entry)
  pending.push(entry)
  schedule()
  return entry
}

/** Cerrado a mano: su entrada se consume, salvo que no esté a la vista (se navegó a otra ruta). */
function release(entry: Entry) {
  const i = stack.indexOf(entry)
  if (i === -1) return
  stack.splice(i, 1)
  if (!entry.depth || entry.depth > depthOf(window.history.state)) return
  released.push(entry.depth)
  schedule()
}

/** Desmontado abierto: sale de la pila sin tocar el historial. */
function drop(entry: Entry) {
  const i = stack.indexOf(entry)
  if (i !== -1) stack.splice(i, 1)
}

/**
 * Mientras `isOpen`, el «atrás» del sistema llama a `close`. `enabled` lo apaga donde el overlay
 * no tapa la pantalla (el asistente flotante de desktop).
 */
export function useBackClose(
  isOpen: WatchSource<boolean>,
  close: () => void,
  enabled: () => boolean = () => true,
) {
  if (!hasHistory()) return
  listen()
  let entry: Entry | null = null
  watch(
    [isOpen, enabled],
    ([open, on]) => {
      if (open && on && !entry) entry = push(close)
      else if ((!open || !on) && entry) {
        release(entry)
        entry = null
      }
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    if (entry) drop(entry)
    entry = null
  })
}
