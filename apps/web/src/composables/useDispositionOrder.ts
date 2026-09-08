import { DISPOSITION_ORDER, type TaskDisposition } from '@ia-flow/shared'
import { computed, type Ref, ref } from 'vue'

/**
 * El orden por disposición, congelado — la mecánica que comparten las cuatro
 * vistas que son recortes del MISMO orden (O6): Qué sigue, Tareas, Board y
 * Ejecuciones.
 *
 * Dos cosas, y las dos son de la UI (la disposición la decide el server):
 *
 * **1 · El orden no se recalcula solo.** Un orden que depende del estado se
 * reordena con cada evento del socket, y eso significa que la fila que ibas a
 * tocar se mueve bajo el dedo. Se congela al abrir; los datos nuevos cambian el
 * CONTENIDO de la fila donde está, y arriba aparece `N cambiaron de lugar ·
 * reordenar`. Reordenar es un gesto del usuario.
 *
 * **2 · Agrupar por bucket**, en el orden de los cuatro, sin dibujar los
 * vacíos (R10).
 *
 * Es una lista de ids y no un snapshot de las filas: así una fila que cambió de
 * razón se re-dibuja al instante —que es información útil— sin moverse.
 *
 * Vive en `composables/` y no en una feature porque lo comparten cuatro
 * pantallas de tres features distintas, y una feature no importa de otra.
 */

export interface DispositionRow {
  id: string
  disposition: TaskDisposition
}

export interface DispositionBucket<T extends DispositionRow> {
  disposition: TaskDisposition
  rows: T[]
}

export function useDispositionOrder<T extends DispositionRow>(rows: Ref<T[]>) {
  /** Los ids en el orden con el que se abrió la pantalla. Vacío ⇒ todavía no se
   *  congeló nada, y la primera carga que traiga filas lo hace. */
  const frozen = ref<string[]>([])

  const incoming = computed(() => rows.value.map((r) => r.id))

  /** Cuántas cambiarían de lugar si se reordenara ahora. Cero ⇒ no se dibuja
   *  el aviso: un cartel que dice "nada cambió" es chrome. */
  const movedCount = computed(() => {
    if (!frozen.value.length) return 0
    const next = incoming.value
    let moved = 0
    for (let i = 0; i < next.length; i++) {
      if (frozen.value[i] !== next[i]) moved++
    }
    return moved
  })

  function freeze() {
    frozen.value = [...incoming.value]
  }

  /** Se llama en cada carga. Sólo congela la PRIMERA vez — ése es todo el
   *  punto: las siguientes dejan el orden quieto y suben `movedCount`. */
  function freezeIfFirst() {
    if (!frozen.value.length && incoming.value.length) freeze()
  }

  function reset() {
    frozen.value = []
  }

  /**
   * Las filas en el orden congelado.
   *
   * Una fila nueva que el orden viejo no conoce va al FINAL: meterla en su
   * lugar sería reordenar sin permiso, que es exactamente lo que este
   * mecanismo evita.
   */
  const ordered = computed<T[]>(() => {
    if (!frozen.value.length) return rows.value
    const byId = new Map(rows.value.map((r) => [r.id, r]))
    const out: T[] = []
    const seen = new Set<string>()
    for (const id of frozen.value) {
      const row = byId.get(id)
      if (row) {
        out.push(row)
        seen.add(id)
      }
    }
    for (const row of rows.value) if (!seen.has(row.id)) out.push(row)
    return out
  })

  const buckets = computed<DispositionBucket<T>[]>(() =>
    DISPOSITION_ORDER.map((disposition) => ({
      disposition,
      rows: ordered.value.filter((r) => r.disposition === disposition),
    })).filter((b) => b.rows.length > 0),
  )

  return { ordered, buckets, movedCount, freeze, freezeIfFirst, reset }
}
