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
import { type Steps, referencesSteps, resolveSteps } from './steps.js'

export interface ActionRunRecorder {
  /** Se llama antes y después de cada acción. Es el gancho por el que una
   *  acción `http` queda persistida en `action_runs` — sin eso, un reinicio
   *  entre "el evento llegó" y "la llamada salió" la pierde sin rastro. */
  onActionStart?(info: {
    rule: Rule
    event: EngineEvent
    position: number
    kind: string
    /** Cómo se llama esta acción, cuando la regla la ejecutó por `ref`. Una
     *  acción inline no tiene nombre y no lo inventa: la fila la identifica su
     *  regla más su posición. */
    name?: string
  }): Promise<string | undefined>
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

/** Lo que devuelve resolver una `ref`: el cuerpo a ejecutar, más cómo se llama.
 *  El nombre viaja al LADO del cuerpo y no adentro: el handler no debe poder
 *  distinguir una acción con nombre de una inline —eso es lo que las hace
 *  ejecutables por el mismo camino—, pero la fila que queda en el listado sí
 *  tiene que decir cuál corrió. */
export type ResolvedAction = { entry: RuleActionEntry; name?: string }

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
  /**
   * Resuelve una acción con nombre a su cuerpo ejecutable.
   *
   * Se inyecta porque este paquete no tiene I/O: quien lo cablea le pasa el
   * repositorio ya acotado al ámbito del evento, y por eso una `ref` a la
   * acción de otro proyecto no resuelve — no porque acá se chequee, sino
   * porque nunca entra en el resultado.
   *
   * Ausente ⇒ las refs no resuelven y la acción falla con su motivo. Es lo
   * correcto para un test o un deploy que no las usa: mejor un fallo legible
   * que una ref silenciosamente ignorada.
   *
   * Recibe el EVENTO y no sólo el id porque el ámbito visible depende de él:
   * `deps` es uno solo para todo el proceso, así que un closure sobre el
   * proyecto resolvería siempre contra el mismo — el bug clásico de este
   * cableado.
   */
  resolveAction?: (actionId: string, event: EngineEvent) => Promise<ResolvedAction | null>
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
  // `position` se reescribe en cada vuelta del loop de abajo: el contexto es
  // el mismo objeto para toda la secuencia —las acciones corren en orden y
  // ninguna lo retiene— y armar uno nuevo por acción sólo para un número
  // duplicaría el resto del cableado.
  const ctx: ActionContext = {
    event,
    rule,
    position: 0,
    fromAgents: [],
    emit: (type, payload, scope) => deps.emit(event, type, payload, scope),
  }
  let ranSomething = false
  let deferred = false
  // Lo que cada paso nombrado dejó. Se llena a medida que corren, así que una
  // acción sólo puede leer pasos ANTERIORES — no hay forma de escribir una
  // regla que dependa de algo que todavía no pasó.
  const steps: Steps = {}

  for (const [position, raw] of rule.do.entries()) {
    // Una `ref` se resuelve ANTES de buscar handler: a partir de acá una acción
    // con nombre y una inline son el mismo objeto, y el resto del loop —schema,
    // recorder, continueOnError— no sabe cuál era cuál.
    let entry = raw
    let name: string | undefined
    if ((raw as RuleAction).action === 'ref') {
      const { actionId } = raw as { actionId: string }
      const resolved = await deps.resolveAction?.(actionId, event)
      if (!resolved) {
        // Puede pasar aunque el CRUD valide: alguien borró la acción después
        // de guardar la regla. Falla la acción, no la regla — el resto del
        // `do[]` sigue su curso normal según `continueOnError`.
        deps.onError?.(new Error(`la acción '${actionId}' no existe en este ámbito`), {
          rule,
          position,
          kind: 'ref',
        })
        if (!continueAfterFailure(raw)) break
        continue
      }
      // El `continueOnError` de la REF gana sobre el de la acción referenciada:
      // es una decisión de esta regla sobre esta secuencia, no una propiedad de
      // la acción, que puede ser opcional en una regla y crítica en otra.
      //
      // El `id` viaja por lo mismo, y además porque no puede vivir del otro
      // lado: nombra el PASO dentro de esta secuencia, no la acción reusable.
      // Sin arrastrarlo, un `{action: 'ref', id: 't'}` publicaba su output bajo
      // el `id` del body de la acción con nombre (o bajo ninguno), y el paso
      // siguiente fallaba con "'t' no corrió antes en esta regla".
      name = resolved.name ?? actionId
      entry = {
        ...resolved.entry,
        ...(raw.continueOnError !== undefined ? { continueOnError: raw.continueOnError } : {}),
        ...((raw as { id?: string }).id !== undefined ? { id: (raw as { id?: string }).id } : {}),
      } as RuleActionEntry
    }

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

    // Los `{{steps.*}}` se resuelven ANTES del schema: así el schema sigue
    // siendo estricto (`method` es un enum, no `string | plantilla`) y lo que
    // se valida es el valor ya resuelto.
    let config: unknown = entry
    let fromAgents: string[] = []
    if (referencesSteps(entry)) {
      const resolved = resolveSteps(entry, steps)
      if (resolved.errors.length) {
        // Una referencia que no resuelve NO se deja pasar: el paso correría con
        // un valor vacío y nadie se enteraría.
        deps.onError?.(new Error(resolved.errors.join('; ')), { rule, position, kind })
        if (!continueAfterFailure(entry)) break
        continue
      }
      config = resolved.value
      // Quién escribió lo que esta acción va a usar. Sólo los agentes: un
      // script o un http los escribió el operador.
      fromAgents = resolved.used.filter((u) => u.from === 'agent').map((u) => u.id)
    }

    const parsed = handler.configSchema.safeParse(config)
    if (!parsed.success) {
      deps.onError?.(parsed.error, { rule, position, kind })
      if (!continueAfterFailure(entry)) break
      continue
    }

    ctx.position = position
    ctx.fromAgents = fromAgents
    const runId = await deps.recorder?.onActionStart?.({ rule, event, position, kind, name })
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

    // Se publica sólo lo de un paso NOMBRADO, y sólo si corrió: un paso que
    // falló o se salteó no dejó un valor, y ofrecerlo como vacío sería el
    // mismo hueco silencioso que la resolución de arriba evita.
    const stepId = (entry as { id?: string }).id
    if (stepId && result.ok && result.output !== undefined) {
      steps[stepId] = { output: result.output, from: kind }
    }

    if (result.deferred) deferred = true
    if (result.ok) ranSomething = true
    // `skipped` no corta la secuencia: significa "no aplicaba", no "se rompió".
    // Sin esta distinción una acción que legítimamente no tenía nada que hacer
    // se llevaba puestas las que venían después — ver ActionResult.skipped.
    if (!result.ok && !result.skipped && !continueAfterFailure(entry)) break
  }

  if (deferred) return 'deferred'
  return ranSomething ? 'dispatched' : 'skipped'
}

function continueAfterFailure(entry: RuleActionEntry): boolean {
  return (entry as { continueOnError?: boolean }).continueOnError === true
}
