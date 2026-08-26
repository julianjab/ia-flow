// Consolidates the "apply an outcome transition + broadcast task:updated"
// pattern that used to repeat inline at every finalize point in
// AgentOrchestrator (success, truncated-pause, terminal error). Kept as two
// functions (not one) because success and error outcomes are triggered by
// different conditions and error carries an optional `error` field injected
// onto the task before the transition runs.
//
// Es también el único lugar que resuelve QUÉ salida aplica. Los dos caminos
// (éxito y fallo) pasan por `resolveExit`, así que la elección del agente
// (`chosenExit`) gana en los dos con la misma regla y sin que ningún caller
// tenga que acordarse de mirarla.
import type { ITaskSource } from '@ia-flow/issue-sources'
import {
  type AgentExit,
  type CommentTarget,
  ERROR_EXIT,
  SUCCESS_EXIT,
  type Task,
  exitSet,
  exitWhen,
  resolveCommentTarget,
} from '@ia-flow/shared'
import { createLogger } from './logger.js'
import { applyOutcome } from './outcomes.js'

const log = createLogger('run-outcome')

export interface OutcomeEntry {
  /** Salidas declaradas por el operador. `success`/`error` son los defaults
   *  que el engine elige según cómo terminó el run; el resto son elegibles. */
  exits?: Record<string, AgentExit>
  /** Salida que el agente pidió por nombre (`select_exit`, o el `exit` de
   *  complete_task/fail_task). Ya validada contra `exits` al momento de
   *  pedirla — acá se vuelve a chequear porque es barato y porque una entrada
   *  rehidratada puede traer otros `exits` que los del run original. */
  chosenExit?: string
  /** Default del AGENTE para dónde comentar. La salida gana sobre esto, y
   *  esto sobre `pr-else-issue`. */
  commentTarget?: CommentTarget
}

type BroadcastFn = (msg: object) => void

/**
 * La transición a aplicar: la que el agente eligió, o el default del camino.
 *
 * Que la elección del agente valga también en el camino de ÉXITO no es un
 * descuido: el resultado del run y la transición son hechos distintos. Un
 * agente puede terminar bien y aun así querer mandar el issue por otra arista
 * (el refiner que valida todo y decide que le toca al builder), y el log
 * guarda las dos cosas por separado.
 */
export function resolveExit(entry: OutcomeEntry, fallback: string): string | undefined {
  const exits = entry.exits
  if (!exits) return undefined
  const chosen = entry.chosenExit
  if (chosen) {
    const picked = exitSet(exits[chosen])
    if (picked) return picked
    // No debería pasar (se valida al elegir), pero si pasa se cae al default
    // en vez de no transicionar: dejar el issue quieto es peor que moverlo por
    // la arista normal, porque nadie lo vuelve a tomar.
    log.warn(
      { chosen, declared: Object.keys(exits) },
      'La salida elegida no está declarada — se aplica la salida por defecto',
    )
  }
  return exitSet(exits[fallback])
}

/**
 * Dónde comentar al cerrar por esta salida: **salida > agente > default**.
 *
 * Se resuelve contra la MISMA salida que `resolveExit` va a aplicar (la
 * elegida por el agente, o el default del camino), porque el destino del
 * comentario y la transición son dos caras del mismo hecho: un e2e-tester que
 * manda el issue de vuelta a refinamiento tiene que dejar su hallazgo donde el
 * refiner lo va a leer y donde sobreviva al PR que lo motivó, mientras que el
 * mismo agente reportando un bug de implementación lo deja junto al código.
 *
 * Ojo con la asimetría respecto de `resolveExit`: si el agente pide una salida
 * NO declarada, allá se cae al default del camino y acá también — pero acá el
 * fallback se busca igual aunque `exits` no exista, porque un agente sin
 * salidas declaradas igual comenta.
 */
export function resolveExitCommentTarget(entry: OutcomeEntry, fallback: string): CommentTarget {
  const exits = entry.exits
  const chosen = entry.chosenExit
  const exit = (chosen ? exits?.[chosen] : undefined) ?? exits?.[fallback]
  return resolveCommentTarget(exit, entry.commentTarget)
}

export async function applySuccessOutcome(
  task: Task,
  entry: OutcomeEntry,
  manager: ITaskSource,
  broadcast: BroadcastFn,
): Promise<Task> {
  const outcome = resolveExit(entry, SUCCESS_EXIT)
  if (outcome) {
    task = await applyOutcome(task, outcome, manager)
    broadcast({ type: 'task:updated', task })
  }
  return task
}

/**
 * Runs the error exit, with `errMsg` injected onto the task as `.error` when
 * provided (matching the two original call sites).
 * Callers remain responsible for any pre-transition notification
 * (postComment / postError) — those differ in placement between call sites
 * and are NOT folded in here.
 */
export async function applyErrorOutcome(
  task: Task,
  entry: OutcomeEntry,
  manager: ITaskSource,
  broadcast: BroadcastFn,
  errMsg?: string,
): Promise<Task> {
  const outcome = resolveExit(entry, ERROR_EXIT)
  if (outcome) {
    const input = errMsg !== undefined ? ({ ...task, error: errMsg } as Task) : task
    task = await applyOutcome(input, outcome, manager)
    broadcast({ type: 'task:updated', task })
  }
  return task
}

/**
 * Las salidas que el agente puede pedir: las declaradas menos las dos
 * reservadas, que el engine ya elige solo. Vacío ⇒ el agente no elige nada y el
 * parámetro `exit` no se le ofrece.
 *
 * Devuelve el `when` junto al nombre porque es lo que termina siendo la
 * descripción del enum: un nombre pelado no le dice al modelo cuándo usarlo.
 */
export function selectableExits(
  exits?: Record<string, AgentExit>,
): Array<{ name: string; when?: string }> {
  if (!exits) return []
  return Object.keys(exits)
    .filter((k) => k !== SUCCESS_EXIT && k !== ERROR_EXIT)
    .map((name) => ({ name, when: exitWhen(exits[name]) }))
}
