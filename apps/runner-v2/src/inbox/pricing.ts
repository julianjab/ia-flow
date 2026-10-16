/**
 * El costo ESTIMADO de una ejecución en USD: sus tokens por modelo (de la traza) por los precios
 * de `pricing:` en runner.yaml. Puro: la tabla entra armada y el uso ya leído.
 *
 * Un request de un provider de suscripción (`claude-cli`, `claude-tmux`: su span lo abre el scope
 * del CLI) no se cobra por token: no suma a `usd`, marca `subscription`. Un modelo sin precio deja
 * la ejecución sin `usd` (y lo nombra en `unpriced_models`): un total a medias engaña.
 */
import type { ExecutionCost } from '@ia-flow/shared'
import { z } from 'zod'

/** USD por millón de tokens. Sin `cacheRead`, 0.1× la entrada; sin `cacheWrite`, 1.25× (la
 *  escritura de caché de 5 minutos). */
export const ModelPriceSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
})
export type ModelPrice = z.infer<typeof ModelPriceSchema>

/** `pricing:` de runner.yaml: por id de modelo. Pisa (o suma a) `DEFAULT_PRICING`. */
export const PricingSection = z.record(z.string().min(1), ModelPriceSchema).default({})
export type Pricing = Record<string, ModelPrice>

/**
 * Los precios de lista de la API de Anthropic (primera parte), USD por millón de tokens, al
 * 2026-10. Cache read: el publicado donde difiere de 0.1× la entrada (Fable 5.1, Fable 5,
 * Opus 5.5, Sonnet 5.5); el resto, 0.1×. Haiku 5.5: el precio hasta 100K tokens de prompt.
 * Bedrock y Vertex cobran distinto: sus ids (`anthropic.claude-…`) no matchean, a propósito.
 */
export const DEFAULT_PRICING: Pricing = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

/** El scope de los spans `chat <modelo>` del provider del CLI (`@ia-flow/provider-shared`,
 *  `RunChannel`): `claude-cli` y `claude-tmux`, de suscripción. */
export const SUBSCRIPTION_SCOPE = '@ia-flow/provider-anthropic-cli'

/** Los tokens de una ejecución para un modelo y un scope (`usageByModel` del datasource). */
export interface ModelUsage {
  model: string
  scope?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export function pricingTable(own: Pricing = {}): Pricing {
  return { ...DEFAULT_PRICING, ...own }
}

/** El precio de un modelo: por su id, o por el id sin la fecha (`claude-x-20260901` → `claude-x`)
 *  ni el sufijo de contexto (`[1m]`). */
export function priceOf(table: Pricing, model: string): ModelPrice | undefined {
  const bare = model.replace(/\[[^\]]*\]$/, '')
  return table[bare] ?? table[bare.replace(/-\d{8}$/, '')]
}

const PER_TOKEN = 1 / 1_000_000
const round = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000

function usdOf(price: ModelPrice, usage: ModelUsage): number {
  const cacheRead = price.cacheRead ?? price.input * 0.1
  const cacheWrite = price.cacheWrite ?? price.input * 1.25
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) *
    PER_TOKEN
  )
}

const tokensOf = (usage: ModelUsage) =>
  usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens

/** El costo estimado de unos tokens; sin tokens, nada. */
export function estimateCost(table: Pricing, usages: ModelUsage[]): ExecutionCost | undefined {
  let usd = 0
  let billed = false
  let subscription = false
  const unpriced = new Set<string>()
  for (const usage of usages.filter((entry) => tokensOf(entry) > 0)) {
    if (usage.scope === SUBSCRIPTION_SCOPE) {
      subscription = true
      continue
    }
    const price = priceOf(table, usage.model)
    if (!price) {
      unpriced.add(usage.model)
      continue
    }
    billed = true
    usd += usdOf(price, usage)
  }
  return costOf(billed, usd, subscription, unpriced)
}

/** El de varias ejecuciones (una tarea): la suma, con las mismas reglas. */
export function sumCosts(costs: Array<ExecutionCost | undefined>): ExecutionCost | undefined {
  let usd = 0
  let billed = false
  let subscription = false
  const unpriced = new Set<string>()
  for (const cost of costs) {
    if (!cost) continue
    if (cost.usd !== undefined) {
      billed = true
      usd += cost.usd
    }
    if (cost.subscription) subscription = true
    for (const model of cost.unpriced_models ?? []) unpriced.add(model)
  }
  return costOf(billed, usd, subscription, unpriced)
}

function costOf(
  billed: boolean,
  usd: number,
  subscription: boolean,
  unpriced: Set<string>,
): ExecutionCost | undefined {
  if (!billed && !subscription && unpriced.size === 0) return undefined
  return {
    ...(billed && unpriced.size === 0 ? { usd: round(usd) } : {}),
    ...(subscription ? { subscription: true } : {}),
    ...(unpriced.size > 0 ? { unpriced_models: [...unpriced].sort() } : {}),
  }
}

export const COST_NOTE =
  'Costo ESTIMADO en USD: tokens × precios de lista por modelo (`pricing:` de runner.yaml), incluida la escritura de caché. No es una factura. `subscription`: tokens de un provider de suscripción (claude-cli), sin costo por token. Sin `usd`: algún modelo no tiene precio (`unpriced_models`).'

/** Lo que el asistente lee de una tarea: el total de sus ejecuciones (las que se ven) y cómo
 *  leerlo. Sin tokens, nada. */
export function taskCost(executions: Array<{ cost?: ExecutionCost }>) {
  const total = sumCosts(executions.map((execution) => execution.cost))
  if (!total) return {}
  return {
    cost_usd: total.usd,
    cost: total,
    cost_note: COST_NOTE,
  }
}

/** `~$1.23` (o `~$0.004`): para un texto que lee una persona o el asistente. */
export function usdText(usd: number): string {
  return usd >= 0.1 ? `~$${usd.toFixed(2)}` : `~$${usd.toPrecision(1)}`
}
