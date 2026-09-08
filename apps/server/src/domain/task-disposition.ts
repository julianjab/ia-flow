import type { ExecutionLog, TaskDisposition, TaskVerb } from '@ia-flow/shared'

/**
 * Quién tiene que mover la próxima pieza.
 *
 * Es la regla de orden de toda la app —Tareas, Runs y Board son tres recortes
 * del mismo orden (O6)— y por eso vive en `domain/`: sin I/O, sin saber de
 * SQLite ni de GitHub, decidible con los hechos ya en memoria y testeable sin
 * levantar nada. Quien los junta es el use-case; acá sólo se decide.
 *
 * El caso que la motivó, y que la app de hoy no distingue: un run que falló
 * **con** regla de retry y uno que falló **sin** ella dicen los dos `✕ falló`.
 * Pero uno se arregla solo en dos minutos y el otro está muerto hasta que
 * alguien lo toque. Esa diferencia es la que separa "te espera" de "avanza
 * solo", y el cliente no puede verla: depende de las reglas configuradas.
 */

export interface DispositionFacts {
  taskId: string
  /** El último run de esta tarea, o `null` si nunca corrió. */
  last: ExecutionLog | null
  /** Runs de AGENTE de esta tarea. Las acciones de una regla no son intentos. */
  attempts: number
  /**
   * Los blockers sin resolver.
   *
   * `undefined` es **"no se pudo saber"**, que no es lo mismo que `[]`. Una
   * fuente que no modela dependencias, o una consulta que falló, no habilita a
   * decir que la tarea está libre — y una tarea que se ordena como libre
   * cuando está trabada es exactamente el error que este modelo existe para
   * evitar.
   */
  blockers?: string[]
  /** El PR abierto de la tarea, si hay. `ci` es el rollup del último commit. */
  openPr?: { number: number; url: string; ci?: 'success' | 'failure' | 'pending' | null }
  /** ¿Alguna regla configurada va a tomar este fallo? Lo contesta el matcher
   *  real del engine, no una heurística — ver el use-case. */
  hasRetryRule: boolean
  /**
   * La FUENTE dice que el ítem está cerrado.
   *
   * Sólo cuando lo dice ella (`meta.state === 'closed'`): no se adivina por el
   * nombre del status. Un proyecto puede llamarle `Done`, `Shipped`, `Listo` o
   * `Fase 4`, y una lista de palabras en el server acertaría en los repos de
   * quien la escribió y fallaría callada en el resto — mandando al bucket
   * plegado tareas que sí te esperan. Una fuente que no lo modela deja esto en
   * `false` y la tarea se clasifica por su run, que es la señal que sí hay.
   */
  isClosed: boolean
  /** Cuántos ítems dependen de éste (grafo de blockers invertido). */
  unblocks: number
}

export interface DispositionVerdict {
  disposition: TaskDisposition
  reason: string
  waitingOnYouSince: string | null
  verb: TaskVerb | null
}

/** `2 intentos` sólo cuando hubo más de uno: decir "1 intento" es ruido. */
function attemptsSuffix(attempts: number): string {
  return attempts > 1 ? ` ${attempts}×` : ''
}

export function resolveDisposition(f: DispositionFacts): DispositionVerdict {
  const blockers = f.blockers ?? []
  const blockersUnknown = f.blockers === undefined

  // ── 4 · cerrado ──────────────────────────────────────────────────────────
  // Va PRIMERO porque gana a todo lo demás: una tarea en Done con un run viejo
  // fallido no te espera, ya pasó. Ordenar por el run y no por el status era
  // exactamente lo que ponía basura arriba.
  if (f.isClosed) {
    return {
      disposition: 'closed',
      reason: 'cerrada',
      waitingOnYouSince: null,
      verb: null,
    }
  }

  // ── 2 · avanza solo (corriendo) ──────────────────────────────────────────
  // Antes que los bloqueos: si YA está corriendo, el bloqueo no la frena — el
  // dispatcher la dejó pasar. Decir "bloqueada" sobre algo que está corriendo
  // sería contradecir a la pantalla de al lado.
  if (f.last && !f.last.finishedAt) {
    return {
      disposition: 'moving',
      reason: `corriendo · ${f.last.agentId}`,
      waitingOnYouSince: null,
      verb: null,
    }
  }

  // ── 3 · trabado por otro ─────────────────────────────────────────────────
  if (blockers.length) {
    return {
      disposition: 'blocked',
      reason: `espera ${blockers.slice(0, 2).join(', ')}${blockers.length > 2 ? ` +${blockers.length - 2}` : ''}`,
      waitingOnYouSince: null,
      verb: null,
    }
  }

  // ── 1 vs 2 · el fallo, que es donde está la decisión ─────────────────────
  if (f.last && f.last.outcome === 'error') {
    const what = f.last.failureClass ? ` · ${f.last.failureClass}` : ''
    if (f.hasRetryRule) {
      return {
        disposition: 'moving',
        reason: `falló${attemptsSuffix(f.attempts)}${what} · reintenta solo`,
        waitingOnYouSince: null,
        verb: null,
      }
    }
    return {
      disposition: 'waiting-on-you',
      reason: `falló${attemptsSuffix(f.attempts)}${what} · no hay regla de retry`,
      // Desde que quedó en tus manos = desde que terminó el run que nadie va a
      // reintentar. NO desde el último evento de la tarea.
      waitingOnYouSince: f.last.finishedAt ?? f.last.startedAt ?? null,
      verb: { label: 'Reintentar', kind: 'run' },
    }
  }

  // Un run abortado a mano y sin resolver sigue esperándote: nadie lo va a
  // retomar, y a diferencia de un fallo no hay regla que pueda tomarlo.
  if (f.last && f.last.outcome === 'cancelled') {
    return {
      disposition: 'waiting-on-you',
      reason: 'abortado a mano · sin resolver',
      waitingOnYouSince: f.last.finishedAt ?? f.last.startedAt ?? null,
      verb: {
        label: 'Resolver',
        kind: 'route',
        href: `/general/aborted-runs?run=${encodeURIComponent(f.last.id)}`,
        hint: '· runs abortados',
      },
    }
  }

  // ── El PR abierto ────────────────────────────────────────────────────────
  // Con el CI terminado, la próxima pieza la mueve un humano — vos. Con el CI
  // todavía corriendo, no: esperar a que termine es que avance solo.
  if (f.openPr) {
    const ci = f.openPr.ci
    if (ci === 'pending' || ci === undefined) {
      return {
        disposition: 'moving',
        reason: `PR #${f.openPr.number} · CI corriendo`,
        waitingOnYouSince: null,
        verb: null,
      }
    }
    return {
      disposition: 'waiting-on-you',
      reason:
        `PR #${f.openPr.number} · CI ${ci === 'success' ? '✓' : '✕'}` +
        (f.unblocks > 0 ? ` · traba ${f.unblocks} ${f.unblocks === 1 ? 'tarea' : 'tareas'}` : ''),
      waitingOnYouSince: f.last?.finishedAt ?? null,
      // Aprobar o mergear desde la app NO existe (ver §7 del handoff). La fila
      // no ofrece un botón que finja hacerlo: linkea al PR. El día que exista,
      // cambia el destino del verbo y nada más de la fila.
      verb: {
        label: 'Revisar el PR',
        kind: 'external',
        href: f.openPr.url,
        hint: '↗ github',
      },
    }
  }

  // ── Nunca corrió ─────────────────────────────────────────────────────────
  if (!f.last) {
    // Sin saber de sus bloqueos se dice lo que SÍ se sabe y nada más: "sin
    // ejecutar" es cierto; "no está bloqueada" no consta.
    if (blockersUnknown) {
      return {
        disposition: 'waiting-on-you',
        reason: 'sin ejecutar · bloqueos sin consultar',
        waitingOnYouSince: null,
        verb: { label: 'Elegir agente y correr', kind: 'run' },
      }
    }
    return {
      disposition: 'waiting-on-you',
      reason: 'sin ejecutar · ninguna regla la tomó',
      waitingOnYouSince: null,
      verb: { label: 'Elegir agente y correr', kind: 'run' },
    }
  }

  // Terminó bien, sin PR abierto y sin bloqueos: el outcome del run ya movió
  // el status y nadie espera nada.
  //
  // Se clasifica como cerrado aunque la fuente no lo confirme, y la dirección
  // del error es deliberada: el riesgo real de este modelo es que el bucket 1
  // crezca sin fin hasta volver a ser una bandeja de entrada, y ahí el orden no
  // sirvió de nada. Un cerrado de más se pliega (O4); un "te espera" de más
  // compite con los que sí te esperan.
  if (f.last.outcome === 'success') {
    return {
      disposition: 'closed',
      reason: 'terminó',
      waitingOnYouSince: null,
      verb: null,
    }
  }

  // Terminado de cualquier otra forma (truncado, sin outcome): no hay quién lo
  // retome.
  return {
    disposition: 'waiting-on-you',
    reason: f.last.outcome ? `terminó ${f.last.outcome} · sin regla que lo tome` : 'sin resultado',
    waitingOnYouSince: f.last.finishedAt ?? null,
    verb: { label: 'Reintentar', kind: 'run' },
  }
}

/**
 * El orden dentro de un bucket.
 *
 * En `te espera`, en cascada (los tres desempates del handoff):
 *   1. cuánto DESBLOQUEA — el único criterio que mide consecuencia y no
 *      antigüedad. Un PR que traba cuatro tareas vale más que un fallo aislado.
 *   2. cuánto lleva esperándote — el más viejo primero.
 *   3. costo de la acción: primero lo que se resuelve con un toque.
 *
 * En los otros tres manda el reloj, con signos distintos: en `avanza solo`
 * primero lo que arrancó hace MÁS (es lo que puede estar colgado — un run de 40
 * minutos cuando el p50 del agente es 6 es la única fila del bucket que merece
 * atención); en `cerrado`, lo más reciente.
 */
const VERB_COST: Record<TaskVerb['kind'], number> = {
  run: 0,
  cancel: 0,
  route: 1,
  external: 2,
}

export interface SortableEntry {
  disposition: TaskDisposition
  unblocks: number
  waitingOnYouSince: string | null
  verb: TaskVerb | null
  /** Para el reloj de los buckets 2, 3 y 4. */
  at: string | null
}

export function compareWithinBucket(a: SortableEntry, b: SortableEntry): number {
  if (a.disposition === 'waiting-on-you') {
    if (a.unblocks !== b.unblocks) return b.unblocks - a.unblocks
    const aw = a.waitingOnYouSince ?? ''
    const bw = b.waitingOnYouSince ?? ''
    // Sin timestamp va último dentro de su escalón: no se puede afirmar que
    // lleva esperando, y adelantarlo sería inventar antigüedad.
    if (aw !== bw) return (aw || '9999') < (bw || '9999') ? -1 : 1
    return VERB_COST[a.verb?.kind ?? 'external'] - VERB_COST[b.verb?.kind ?? 'external']
  }
  const aa = a.at ?? ''
  const ba = b.at ?? ''
  if (aa === ba) return 0
  // `closed`: lo más reciente primero. `moving`/`blocked`: lo más viejo.
  return a.disposition === 'closed' ? (aa > ba ? -1 : 1) : aa < ba ? -1 : 1
}
