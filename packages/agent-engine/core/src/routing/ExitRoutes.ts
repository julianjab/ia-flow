import { z } from 'zod'
import type { ToolInputSchema } from '../agent/SchemaTool.js'
import type { Runnable } from '../pipeline/Runnable.js'

/** Destino "no hacer nada más": la salida termina el recorrido ahí. */
export const END: unique symbol = Symbol.for('agent-engine.END')
export type RouteTarget = Runnable | typeof END
export type RouteTo = RouteTarget | RouteTarget[]

/**
 * Una salida de un agente. `when` es lo que el modelo lee para elegirla (viaja como descripción
 * de la tool `submit_<salida>`); `to` es qué pasos corren si la elige, en orden. Una salida sin
 * `to` es sólo VOCABULARIO: el agente sabe qué significa pero no a dónde lleva, y cada pipeline
 * que lo use tiene que ponerle destino (ej. `comment-triage.actionable`).
 */
export interface ExitRoute {
  when?: string
  to?: RouteTo
  /** Reporte de cierre sólo para esta salida — gana sobre el de cualquier nivel. */
  report?: Runnable | null
}

/** Qué pasa si la corrida del agente tira. Lo decide el engine, nunca el modelo. */
export interface ErrorRoute {
  to?: RouteTo
  /** Input de cada destino a partir del error. */
  input?: (err: Error) => unknown
  /** Input del reporte de cierre a partir del error. Sin esto, un error no reporta. */
  report?: (err: Error) => unknown
}

/**
 * Qué pasa si interrumpen al agente (`ifRunning: 'interrupt'` de la regla que viene): en vez de
 * sus salidas corren estos pasos, con `steps.interruption` (`InterruptionReport`: por qué, y en
 * qué quedó) — típicamente un comentario. Lo decide el engine, nunca el modelo. Sin esto, el
 * agente sólo para.
 */
export interface InterruptRoute {
  to?: RouteTo
}

/** Lo que cualquier nivel puede definir. Proyecto y pipeline sólo pueden esto. */
export interface ExitDefaults {
  onError?: ErrorRoute | null
  onInterrupt?: InterruptRoute | null
  /** El paso que publica el cierre del turno (típicamente `postComment.bind({ target })`).
   *  Corre ANTES que los destinos de la salida: el siguiente agente tiene que ver ese comentario. */
  report?: Runnable | null
}

/** Lo que definen el agente (vocabulario + destinos base) y el paso (overrides). */
export interface ExitRoutes extends ExitDefaults {
  /** `null` elimina la salida (sólo a nivel paso). */
  routes?: Record<string, ExitRoute | null>
}

export type RouteOrigin = 'project' | 'agent' | 'pipeline' | 'step' | 'exit'

export interface ResolvedExit {
  name: string
  when?: string
  targets: Runnable[]
  report: Runnable | null
  origin: RouteOrigin
  reportOrigin: RouteOrigin | null
}

export interface ResolvedRoutes {
  exits: ResolvedExit[]
  onError: { route: ErrorRoute; origin: RouteOrigin } | null
  onInterrupt: { route: InterruptRoute; origin: RouteOrigin } | null
  report: { target: Runnable; origin: RouteOrigin } | null
}

export interface RouteLayers {
  project?: ExitDefaults
  pipeline?: ExitDefaults
  step?: ExitRoutes
}

/** Salida implícita de un agente que no declara ninguna: terminar y ya. */
export const DONE_EXIT = 'done'

const EXIT_NAME = /^[a-zA-Z0-9_-]{1,50}$/

export function routeTargets(to: RouteTo | undefined): Runnable[] {
  if (to === undefined) return []
  const list = Array.isArray(to) ? to : [to]
  return list.filter((target): target is Runnable => target !== END)
}

/** Primer nivel que define la clave, del más específico al más general. `null` corta: "ninguno". */
function firstDefined<T>(
  layers: Array<[RouteOrigin, T | null | undefined]>,
): { value: T; origin: RouteOrigin } | null {
  for (const [origin, value] of layers) {
    if (value === undefined) continue
    return value === null ? null : { value, origin }
  }
  return null
}

/**
 * La cascada entera: **paso > pipeline > agente > proyecto**, mezclando por clave.
 *
 * - Sólo el agente crea salidas. Un override de una salida que el agente no declara es un error
 *   (un typo como `redy` tiene que romper al construir, no quedar como config muerta).
 * - Un override parcial hereda lo que no redefine: cambiar `to` conserva el `when` del agente.
 * - Toda salida termina con destino (`END` cuenta), y queda al menos una.
 * - Un agente sin salidas declaradas tiene una implícita, `done`, que termina.
 *
 * Pura y sin I/O: la usan `Agent` (para armar sus `submit_*`), `Pipeline` (para validar al
 * construirse y para saber qué correr), y `routesOf`/`explain_routes` (para mostrarlo).
 */
export function resolveRoutes(
  agentId: string,
  agent: ExitRoutes,
  layers: RouteLayers = {},
): ResolvedRoutes {
  const declared = agent.routes ?? {}
  const vocabulary = Object.keys(declared)
  const merged = new Map<string, { route: ExitRoute; origin: RouteOrigin }>()

  if (vocabulary.length === 0) {
    merged.set(DONE_EXIT, { route: { to: END }, origin: 'agent' })
  }
  for (const name of vocabulary) {
    if (!EXIT_NAME.test(name)) {
      throw new Error(
        `Agent(${agentId}): salida "${name}" inválida — sólo letras, dígitos, "_" y "-"`,
      )
    }
    const route = declared[name]
    if (route === null) {
      throw new Error(`Agent(${agentId}): "${name}" es null en el agente — sólo un paso elimina`)
    }
    merged.set(name, { route, origin: 'agent' })
  }

  for (const [name, override] of Object.entries(layers.step?.routes ?? {})) {
    const base = merged.get(name)
    if (!base) {
      throw new Error(
        `Agent(${agentId}): la pipeline sobrescribe "${name}", que el agente no declara — declaradas: ${[...merged.keys()].join(', ')}`,
      )
    }
    if (override === null) {
      merged.delete(name)
      continue
    }
    merged.set(name, {
      route: {
        when: override.when ?? base.route.when,
        to: override.to ?? base.route.to,
        report: override.report !== undefined ? override.report : base.route.report,
      },
      origin: 'step',
    })
  }

  if (merged.size === 0) {
    throw new Error(`Agent(${agentId}): la pipeline eliminó todas sus salidas`)
  }

  const report = firstDefined<Runnable>([
    ['step', layers.step?.report],
    ['pipeline', layers.pipeline?.report],
    ['agent', agent.report],
    ['project', layers.project?.report],
  ])

  const exits: ResolvedExit[] = [...merged].map(([name, { route, origin }]) => {
    if (route.to === undefined) {
      throw new Error(
        `Agent(${agentId}): la salida "${name}" no tiene destino — la pipeline tiene que ponérselo en routes.${agentId}.routes.${name}.to`,
      )
    }
    const exitReport =
      route.report !== undefined
        ? { value: route.report, origin: 'exit' as const }
        : report && { value: report.value, origin: report.origin }
    return {
      name,
      when: route.when,
      targets: routeTargets(route.to),
      report: exitReport?.value ?? null,
      origin,
      reportOrigin: exitReport?.value ? exitReport.origin : null,
    }
  })

  const onError = firstDefined<ErrorRoute>([
    ['step', layers.step?.onError],
    ['pipeline', layers.pipeline?.onError],
    ['agent', agent.onError],
    ['project', layers.project?.onError],
  ])

  const onInterrupt = firstDefined<InterruptRoute>([
    ['step', layers.step?.onInterrupt],
    ['pipeline', layers.pipeline?.onInterrupt],
    ['agent', agent.onInterrupt],
    ['project', layers.project?.onInterrupt],
  ])

  return {
    exits,
    onError: onError && { route: onError.value, origin: onError.origin },
    onInterrupt: onInterrupt && { route: onInterrupt.value, origin: onInterrupt.origin },
    report: report && { target: report.value, origin: report.origin },
  }
}

function schemaHasKeys(schema: ToolInputSchema): boolean {
  return Object.keys(schema.shape).length > 0
}

/**
 * El schema de `submit_<salida>`: `{ report?, <idDestino>: <input del destino>, ... }`. Un paso
 * que no acepta input, o cuyo input quedó vacío después de `bind`, no aparece. Una clave cuyo
 * schema acepta `{}` es opcional: el modelo no tiene que mandar un objeto vacío.
 */
export function submitSchemaFor(agentId: string, exit: ResolvedExit): ToolInputSchema {
  const shape: Record<string, z.ZodType> = {}
  const add = (key: string, schema: ToolInputSchema | undefined) => {
    if (!schema || !schemaHasKeys(schema)) return
    if (key in shape) {
      throw new Error(
        `Agent(${agentId}): la salida "${exit.name}" tiene dos pasos con input bajo la clave "${key}"`,
      )
    }
    shape[key] = schema.safeParse({}).success ? schema.optional() : schema
  }
  if (exit.report) add('report', exit.report.acceptsInput())
  for (const target of exit.targets) {
    const schema = target.acceptsInput()
    if (!schema || !schemaHasKeys(schema)) continue
    if (!target.id) {
      throw new Error(
        `Agent(${agentId}): un destino de "${exit.name}" acepta input pero no tiene id`,
      )
    }
    if (target.id === 'report') {
      throw new Error(`Agent(${agentId}): "report" está reservado, un destino no puede usarlo`)
    }
    add(target.id, schema)
  }
  return z.strictObject(shape) as unknown as ToolInputSchema
}
