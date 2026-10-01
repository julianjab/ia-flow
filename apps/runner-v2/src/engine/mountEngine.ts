/**
 * El engine del runner, armado desde la sección `engine:` de `runner.yaml`: el store de
 * ejecuciones (por nombre de driver), el tick que vence pausas, quién cumple las capacidades
 * (`whenText`, `fileFocus`: la fuente global las declara en `sources.capabilities`), el texto con el que un evento le llega a un agente que ya corre (`formatMessage`) y cómo se
 * interrumpe a uno (`interrupt`).
 */
import { isAbsolute, resolve } from 'node:path'
import {
  type CapabilityBindings,
  type DispatchJournal,
  type DomainEvent,
  Engine,
  EventBus,
  type ExecutionGroups,
  type ExecutionStore,
  InMemoryExecutionStore,
  type Pipeline,
  type PipelineSource,
  renderText,
  type TextClassifier,
} from '@ia-flow/agent-engine'
import { z } from 'zod'

export const EngineSection = z.strictObject({
  /** Tope de la cadena de eventos derivados (un paso que emite otro evento). */
  maxEventDepth: z.number().int().positive().optional(),
  executions: z
    .strictObject({
      /** Un driver registrado (`memory` viene incluido; el runner registra `bun-sqlite`). */
      driver: z.string().min(1).default('memory'),
      /** Relativa a `runner.yaml`. */
      path: z.string().min(1).optional(),
      maxConcurrent: z.number().int().min(1).optional(),
    })
    .optional(),
  /** Cada cuánto se vencen las pausas (`engine.tick()`). */
  tick: z.strictObject({ everyMs: z.number().int().positive() }).optional(),
  /** Plantilla contra el payload (`'{{message}}'`); vacía, el mensaje por default del engine. */
  formatMessage: z.string().min(1).optional(),
  /** Las pipelines con `ifRunning: interrupt`: qué le dicen al agente y quién no interrumpe. */
  interrupt: z
    .strictObject({
      /** Qué pasó, en palabras: plantilla contra el payload del evento que interrumpe. Lo lee
       *  el agente en el aviso y queda en `steps.interruption.reason` (el comentario). */
      reason: z.string().min(1).optional(),
      /** Regex sobre `payload.sender`: un evento de esos logins es el eco de un cambio del
       *  propio runner y nunca interrumpe — sólo espera. */
      ownSenders: z.string().min(1).optional(),
    })
    .optional(),
})
export type EngineSection = z.infer<typeof EngineSection>

/** Arma el store de un driver. `path` ya viene resuelto. */
export type StoreDriver = (options: {
  path?: string
  maxConcurrent?: number
  groups?: ExecutionGroups
}) => ExecutionStore

export const memoryDriver: StoreDriver = ({ maxConcurrent, groups }) =>
  new InMemoryExecutionStore({
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    ...(groups ? { groups } : {}),
  })

export interface MountEngineOptions {
  /** Contra qué se resuelven las rutas relativas (la carpeta de `runner.yaml`). */
  baseDir: string
  sources: PipelineSource[]
  drivers: Record<string, StoreDriver>
  /** Los topes por grupo de tasks (por proyecto), debajo del de `executions`. */
  groups?: ExecutionGroups
  /** Quién cumple cada capacidad (ver `EngineOptions.capabilities`). */
  capabilities?: CapabilityBindings
  /** Gana sobre la capacidad `whenText` (tests). */
  textClassifier?: TextClassifier
  /** Dónde queda cada evento con lo que decidió cada pipeline (la base de actividad). */
  dispatchJournal?: DispatchJournal
}

export interface MountedEngine {
  engine: Engine
  bus: EventBus
  executions?: ExecutionStore
  /** Deja de escuchar el bus y de vencer pausas, y cierra el store si tiene cómo. */
  stop(): void
}

function store(
  config: NonNullable<EngineSection['executions']>,
  drivers: Record<string, StoreDriver>,
  baseDir: string,
  groups?: ExecutionGroups,
): ExecutionStore {
  const available: Record<string, StoreDriver> = { memory: memoryDriver, ...drivers }
  const driver = available[config.driver]
  if (!driver) {
    throw new Error(
      `engine.executions.driver "${config.driver}" no está registrado — hay: ${Object.keys(available).join(', ')}`,
    )
  }
  const path =
    config.path === undefined || config.path === ':memory:' || isAbsolute(config.path)
      ? config.path
      : resolve(baseDir, config.path)
  return driver({
    ...(path !== undefined ? { path } : {}),
    ...(config.maxConcurrent !== undefined ? { maxConcurrent: config.maxConcurrent } : {}),
    ...(groups ? { groups } : {}),
  })
}

/** `formatMessage`: la plantilla contra el payload; vacía, el mensaje por default. */
export function messageTemplate(
  template: string | undefined,
): ((event: DomainEvent<any>) => string) | undefined {
  if (!template) return undefined
  return (event) => {
    const payload = event.payload
    const root = typeof payload === 'object' && payload !== null ? payload : {}
    const text = renderText(template, root as Record<string, unknown>).trim()
    return text || `Evento ${event.type}: ${JSON.stringify(event.payload)}`
  }
}

/** `interrupt.reason`: la plantilla contra el payload; vacía (o sin nada que decir), el texto
 *  por default del engine. */
export function interruptReason(
  template: string | undefined,
): ((event: DomainEvent<any>, pipeline: Pipeline) => string) | undefined {
  if (!template) return undefined
  return (event, pipeline) => {
    const payload = event.payload
    const root = typeof payload === 'object' && payload !== null ? payload : {}
    const text = renderText(template, root as Record<string, unknown>).trim()
    return text || `llegó "${event.type}" y va a correr "${pipeline.id}"`
  }
}

/** `interrupt.ownSenders`: si el evento lo mandó un login del propio runner. */
export function ownSender(
  pattern: string | undefined,
): ((event: DomainEvent<any>) => boolean) | undefined {
  if (!pattern) return undefined
  const own = new RegExp(pattern)
  return (event) => {
    const sender = (event.payload as { sender?: unknown } | undefined)?.sender
    return typeof sender === 'string' && own.test(sender)
  }
}

export function mountEngine(config: EngineSection, opts: MountEngineOptions): MountedEngine {
  const executions = config.executions
    ? store(config.executions, opts.drivers, opts.baseDir, opts.groups)
    : undefined
  const bus = new EventBus()
  const formatMessage = messageTemplate(config.formatMessage)
  const reason = interruptReason(config.interrupt?.reason)
  const selfOriginated = ownSender(config.interrupt?.ownSenders)
  const engine = new Engine({
    bus,
    pipelines: opts.sources,
    ...(config.maxEventDepth !== undefined ? { maxEventDepth: config.maxEventDepth } : {}),
    ...(executions ? { executions } : {}),
    ...(formatMessage ? { formatMessage } : {}),
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    ...(opts.textClassifier ? { textClassifier: opts.textClassifier } : {}),
    ...(reason ? { interruptReason: reason } : {}),
    ...(selfOriginated ? { selfOriginated } : {}),
    ...(opts.dispatchJournal ? { dispatchJournal: opts.dispatchJournal } : {}),
  })
  const unsubscribe = engine.start()
  const ticker = config.tick ? setInterval(() => engine.tick(), config.tick.everyMs) : undefined
  ticker?.unref()
  return {
    engine,
    bus,
    ...(executions ? { executions } : {}),
    stop() {
      unsubscribe()
      if (ticker) clearInterval(ticker)
      ;(executions as { close?: () => void } | undefined)?.close?.()
    },
  }
}
