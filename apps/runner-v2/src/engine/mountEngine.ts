/**
 * El engine del runner, armado desde la sección `engine:` de `runner.yaml`: el store de
 * ejecuciones (por nombre de driver), el tick que vence pausas, el clasificador de los `whenText`
 * y el texto con el que un evento le llega a un agente que ya corre (`formatMessage`).
 */
import { isAbsolute, resolve } from 'node:path'
import {
  AnthropicTextClassifier,
  type DomainEvent,
  Engine,
  EventBus,
  type ExecutionStore,
  InMemoryExecutionStore,
  type PipelineSource,
  renderText,
  type TextClassifier,
} from '@ia-tools/agent-engine'
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
  /** El clasificador de los `whenText`: la Messages API de Anthropic. Sin esto, un `whenText`
   *  no deja correr nada. */
  whenText: z
    .strictObject({
      model: z.string().min(1).optional(),
      /** La env var con la API key. Default: `ANTHROPIC_API_KEY`. */
      apiKeyEnv: z.string().min(1).optional(),
    })
    .optional(),
  /** Plantilla contra el payload (`'{{message}}'`); vacía, el mensaje por default del engine. */
  formatMessage: z.string().min(1).optional(),
})
export type EngineSection = z.infer<typeof EngineSection>

/** Arma el store de un driver. `path` ya viene resuelto. */
export type StoreDriver = (options: { path?: string; maxConcurrent?: number }) => ExecutionStore

export const memoryDriver: StoreDriver = ({ maxConcurrent }) =>
  new InMemoryExecutionStore(maxConcurrent !== undefined ? { maxConcurrent } : {})

export interface MountEngineOptions {
  /** Contra qué se resuelven las rutas relativas (la carpeta de `runner.yaml`). */
  baseDir: string
  sources: PipelineSource[]
  drivers: Record<string, StoreDriver>
  /** Gana sobre el de `whenText`. */
  textClassifier?: TextClassifier
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
  })
}

function classifier(config: EngineSection['whenText']): TextClassifier | undefined {
  if (!config) return undefined
  const env = config.apiKeyEnv ?? 'ANTHROPIC_API_KEY'
  return new AnthropicTextClassifier({
    apiKey: () => process.env[env],
    ...(config.model ? { model: config.model } : {}),
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

export function mountEngine(config: EngineSection, opts: MountEngineOptions): MountedEngine {
  const executions = config.executions
    ? store(config.executions, opts.drivers, opts.baseDir)
    : undefined
  const bus = new EventBus()
  const textClassifier = opts.textClassifier ?? classifier(config.whenText)
  const formatMessage = messageTemplate(config.formatMessage)
  const engine = new Engine({
    bus,
    pipelines: opts.sources,
    ...(config.maxEventDepth !== undefined ? { maxEventDepth: config.maxEventDepth } : {}),
    ...(executions ? { executions } : {}),
    ...(formatMessage ? { formatMessage } : {}),
    ...(textClassifier ? { textClassifier } : {}),
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
