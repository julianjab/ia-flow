// Ejecuta el `do[]` de una regla, en orden, y traduce el resultado al outcome
// que el bus le devuelve al publicador.
//
// El orden es parte del contrato: una regla que primero comenta y después mueve
// el status tiene que ser predecible. Por eso una falla corta la secuencia salvo
// `continueOnError`, y correr en paralelo no es un default sino algo que habría
// que pedir explícitamente.
import type { EngineEvent, Rule, RuleAction, RuleActionEntry } from '@ia-flow/shared'
import { getActionHandler } from './actions.js'
import type { ActionContext, ActionResult } from './actions.js'
import type { EventOutcome } from './bus.js'

export interface ActionRunRecorder {
  /** Se llama antes y después de cada acción. Es el gancho por el que una
   *  acción `http` queda persistida en `action_runs` — sin eso, un reinicio
   *  entre "el evento llegó" y "la llamada salió" la pierde sin rastro. */
  onActionStart?(info: { rule: Rule; event: EngineEvent; position: number; kind: string }): Promise<
    string | undefined
  >
  onActionEnd?(info: {
    runId?: string
    rule: Rule
    event: EngineEvent
    position: number
    kind: string
    result: ActionResult
    error?: unknown
  }): Promise<void>
}

export interface RunRuleDeps {
  /**
   * Publica un evento derivado.
   *
   * Recibe el evento causante como primer argumento —en vez de que la acción
   * lo capture— porque el `emit` es uno solo para todo el proceso y la
   * causalidad es por ejecución. Sin esto, el `deriveEvent` del otro lado no
   * tendría de dónde sacar `causationId` ni `depth`, y el tope del bus dejaría
   * de frenar los ciclos.
   */
  emit(
    cause: EngineEvent,
    type: string,
    payload?: Record<string, unknown>,
    scope?: EngineEvent['scope'],
  ): Promise<void>
  recorder?: ActionRunRecorder
  onError?: (err: unknown, info: { rule: Rule; position: number; kind: string }) => void
}

const FAILED: ActionResult = { ok: false }

/** Ejecuta una regla y devuelve su outcome agregado.
 *
 *  `deferred` gana sobre todo, igual que en el bus: significa "hay trabajo,
 *  reintentá", y perderlo detrás de un ok dejaría el item sin reintento. */
export async function runRule(
  rule: Rule,
  event: EngineEvent,
  deps: RunRuleDeps,
): Promise<EventOutcome> {
  // El evento causante queda ligado acá: la acción sólo dice QUÉ emitir, nunca
  // a partir de qué. Es lo que hace imposible emitir un evento que rompa la
  // cadena de causación por descuido.
  const ctx: ActionContext = {
    event,
    rule,
    emit: (type, payload, scope) => deps.emit(event, type, payload, scope),
  }
  let ranSomething = false
  let deferred = false

  for (const [position, entry] of rule.do.entries()) {
    const kind = (entry as RuleAction).action
    const handler = getActionHandler(kind)

    if (!handler) {
      // La validación del CRUD debería haber frenado esto; llegar acá
      // significa que la fila se escribió por otro camino. Se trata como
      // fallo de la acción, no como crash de la regla.
      deps.onError?.(new Error(`acción desconocida: ${kind}`), { rule, position, kind })
      if (!continueAfterFailure(entry)) break
      continue
    }

    const parsed = handler.configSchema.safeParse(entry)
    if (!parsed.success) {
      deps.onError?.(parsed.error, { rule, position, kind })
      if (!continueAfterFailure(entry)) break
      continue
    }

    const runId = await deps.recorder?.onActionStart?.({ rule, event, position, kind })
    let result: ActionResult = FAILED
    let thrown: unknown

    try {
      result = await handler.execute(ctx, parsed.data as never)
    } catch (err) {
      thrown = err
      deps.onError?.(err, { rule, position, kind })
    }

    await deps.recorder?.onActionEnd?.({
      runId,
      rule,
      event,
      position,
      kind,
      result,
      error: thrown,
    })

    if (result.deferred) deferred = true
    if (result.ok) ranSomething = true
    if (!result.ok && !continueAfterFailure(entry)) break
  }

  if (deferred) return 'deferred'
  return ranSomething ? 'dispatched' : 'skipped'
}

function continueAfterFailure(entry: RuleActionEntry): boolean {
  return (entry as { continueOnError?: boolean }).continueOnError === true
}
