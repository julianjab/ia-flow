// Ejecuta el `do[]` de una regla, en orden, y traduce el resultado al outcome
// que el bus le devuelve al publicador.
//
// El orden es parte del contrato: una regla que primero comenta y después mueve
// el status tiene que ser predecible. Por eso una falla corta la secuencia salvo
// `continueOnError`, y correr en paralelo no es un default sino algo que habría
// que pedir explícitamente.
import type { EngineEvent, Rule, RuleAction, RuleActionEntry } from '@ia-flow/shared'
import type { ActionContext, ActionResult } from './actions.js'
import { getActionHandler } from './actions.js'
import type { EventOutcome } from './bus.js'
import { referencesSteps, resolveSteps, type Steps } from './steps.js'
import { evalWhen } from './when.js'

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

/** Lo que dejó ejecutar (o intentar ejecutar) un paso del `do[]`: si hay que
 *  cortar la secuencia, y qué agregar al acumulado de `runRule` (`steps`,
 *  `deferred`, `ranSomething`). `null` en `stepEntry` es "no corrió nada que
 *  reportar" (el `when` del paso no matcheó, la ref/acción no resolvió). */
interface StepRunOutcome {
  result: ActionResult | null
  breakSequence: boolean
}

/** Resuelve una `ref` a su cuerpo ejecutable, arrastrando `continueOnError`,
 *  `id` y `when` de la entrada de la regla por sobre los de la acción
 *  reusable — ver los comentarios largos que esto reemplaza en el `for` de
 *  abajo (git blame de esta función los tiene). `null` significa que la ref
 *  no resolvió: el caller decide si eso corta la secuencia. */
async function resolveRefEntry(
  raw: RuleActionEntry,
  event: EngineEvent,
  deps: RunRuleDeps,
): Promise<{ entry: RuleActionEntry; name?: string } | null> {
  const { actionId } = raw as { actionId: string }
  const resolved = await deps.resolveAction?.(actionId, event)
  if (!resolved) return null

  const name = resolved.name ?? actionId
  const entry = {
    ...resolved.entry,
    ...(raw.continueOnError !== undefined ? { continueOnError: raw.continueOnError } : {}),
    ...((raw as { id?: string }).id !== undefined ? { id: (raw as { id?: string }).id } : {}),
    ...((raw as { when?: unknown }).when !== undefined
      ? { when: (raw as { when?: unknown }).when }
      : {}),
  } as RuleActionEntry
  return { entry, name }
}

/** Si el `when` de la acción (evaluado contra los campos del evento + los
 *  `steps` corridos hasta acá) la deja correr. Ver el comentario largo en
 *  `runStep` sobre por qué `steps` puede pisar una clave del payload. */
function stepWhenMatches(entry: RuleActionEntry, event: EngineEvent, steps: Steps): boolean {
  const stepWhen = (entry as { when?: unknown }).when
  if (!stepWhen) return true
  return evalWhen({ ...event.payload, steps }, stepWhen)
}

/** Resuelve `{{steps.*}}` en la config de la acción y filtra qué agentes
 *  alimentaron algo, ANTES del schema — ver el comentario original de
 *  `runRule` sobre por qué en ese orden. `null` en `error` es éxito. */
function resolveStepReferences(
  entry: RuleActionEntry,
  steps: Steps,
): { config: unknown; fromAgents: string[]; error?: string } {
  if (!referencesSteps(entry)) return { config: entry, fromAgents: [] }

  const resolved = resolveSteps(entry, steps)
  if (resolved.errors.length) {
    return { config: entry, fromAgents: [], error: resolved.errors.join('; ') }
  }
  // Quién escribió lo que esta acción va a usar. Sólo los agentes: un
  // script o un http los escribió el operador.
  const fromAgents = resolved.used.filter((u) => u.from === 'agent').map((u) => u.id)
  return { config: resolved.value, fromAgents }
}

/** Ejecuta un paso del `do[]` — resolviendo su `ref` si la tiene, chequeando
 *  su `when`, resolviendo `{{steps.*}}`, parseando el schema y corriendo el
 *  handler — y actualiza `steps` con lo que dejó, si corrió. Es la unidad
 *  que el `for` de `runRule` repite en orden; separarla no cambia el orden ni
 *  la precedencia de nada, sólo le da nombre a cada sub-paso. */
async function runStep(
  raw: RuleActionEntry,
  position: number,
  rule: Rule,
  event: EngineEvent,
  deps: RunRuleDeps,
  ctx: ActionContext,
  steps: Steps,
): Promise<StepRunOutcome> {
  // Una `ref` se resuelve ANTES de buscar handler: a partir de acá una acción
  // con nombre y una inline son el mismo objeto, y el resto de esta función
  // —schema, recorder, continueOnError— no sabe cuál era cuál.
  let entry = raw
  let name: string | undefined
  if ((raw as RuleAction).action === 'ref') {
    const { actionId } = raw as { actionId: string }
    const resolved = await resolveRefEntry(raw, event, deps)
    if (!resolved) {
      // Puede pasar aunque el CRUD valide: alguien borró la acción después
      // de guardar la regla. Falla la acción, no la regla — el resto del
      // `do[]` sigue su curso normal según `continueOnError`.
      deps.onError?.(new Error(`la acción '${actionId}' no existe en este ámbito`), {
        rule,
        position,
        kind: 'ref',
      })
      return { result: null, breakSequence: !continueAfterFailure(raw) }
    }
    entry = resolved.entry
    name = resolved.name
  }

  const kind = (entry as RuleAction).action
  const handler = getActionHandler(kind)

  if (!handler) {
    // La validación del CRUD debería haber frenado esto; llegar acá
    // significa que la fila se escribió por otro camino. Se trata como
    // fallo de la acción, no como crash de la regla.
    deps.onError?.(new Error(`acción desconocida: ${kind}`), { rule, position, kind })
    return { result: null, breakSequence: !continueAfterFailure(entry) }
  }

  // El `when` de la acción se evalúa ANTES de resolver `{{steps.*}}` y de
  // parsear el schema: si no matchea, el resto de este paso no importa. El
  // sujeto es el mismo que usa el `when` de la regla (los campos del
  // evento) más `steps`, lo que deja al `do[]` referenciar lo que dejó un
  // paso anterior sin pasar por un `emit`. `steps` pisa una clave
  // homónima de `event.payload` si existiera — ningún productor de
  // eventos del catálogo usa ese nombre hoy (es el mismo motivo por el
  // que `{{steps.*}}` en `resolveSteps`/`steps.ts` no se namespacea contra
  // el payload), así que es aditivo en la práctica.
  if (!stepWhenMatches(entry, event, steps)) {
    const runId = await deps.recorder?.onActionStart?.({ rule, event, position, kind, name })
    const result: ActionResult = {
      ok: false,
      skipped: true,
      detail: 'when de la acción no matcheó',
    }
    await deps.recorder?.onActionEnd?.({ runId, rule, event, position, kind, result })
    return { result: null, breakSequence: false }
  }

  // Los `{{steps.*}}` se resuelven ANTES del schema: así el schema sigue
  // siendo estricto (`method` es un enum, no `string | plantilla`) y lo que
  // se valida es el valor ya resuelto.
  const { config, fromAgents, error } = resolveStepReferences(entry, steps)
  if (error) {
    // Una referencia que no resuelve NO se deja pasar: el paso correría con
    // un valor vacío y nadie se enteraría.
    deps.onError?.(new Error(error), { rule, position, kind })
    return { result: null, breakSequence: !continueAfterFailure(entry) }
  }

  const parsed = handler.configSchema.safeParse(config)
  if (!parsed.success) {
    deps.onError?.(parsed.error, { rule, position, kind })
    return { result: null, breakSequence: !continueAfterFailure(entry) }
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

  // `skipped` no corta la secuencia: significa "no aplicaba", no "se rompió".
  // Sin esta distinción una acción que legítimamente no tenía nada que hacer
  // se llevaba puestas las que venían después — ver ActionResult.skipped.
  const breakSequence = !result.ok && !result.skipped && !continueAfterFailure(entry)
  return { result, breakSequence }
}

/** El outcome agregado de la regla, a partir de lo que dejó cada paso.
 *
 *  `deferred` gana sobre todo, igual que en el bus: significa "hay trabajo,
 *  reintentá", y perderlo detrás de un ok dejaría el item sin reintento. */
function resolveRuleOutcome(deferred: boolean, ranSomething: boolean): EventOutcome {
  if (deferred) return 'deferred'
  return ranSomething ? 'dispatched' : 'skipped'
}

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
    const outcome = await runStep(raw, position, rule, event, deps, ctx, steps)
    if (outcome.result?.deferred) deferred = true
    if (outcome.result?.ok) ranSomething = true
    if (outcome.breakSequence) break
  }

  return resolveRuleOutcome(deferred, ranSomething)
}

function continueAfterFailure(entry: RuleActionEntry): boolean {
  return (entry as { continueOnError?: boolean }).continueOnError === true
}
