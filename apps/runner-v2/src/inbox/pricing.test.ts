/**
 * El costo estimado: tokens por precio, nunca un número inventado — sin precio o con suscripción,
 * se dice en vez de sumar.
 */
import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_PRICING,
  estimateCost,
  type ModelUsage,
  PricingSection,
  priceOf,
  pricingTable,
  SUBSCRIPTION_SCOPE,
  sumCosts,
  taskCost,
  usdText,
} from './pricing.js'

const usage = (patch: Partial<ModelUsage>): ModelUsage => ({
  model: 'claude-opus-5-5',
  scope: '@ia-flow/provider-anthropic-api',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...patch,
})

describe('pricing', () => {
  const table = pricingTable()

  it('prices input, output, cache reads and cache writes per million tokens', () => {
    const cost = estimateCost(table, [
      usage({
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 100_000,
      }),
    ])
    // 4 + 2 + 2×0.20 + 0.1×(4×1.25)
    expect(cost).toEqual({ usd: 6.9 })
  })

  it('without cacheRead in the table, a read is 0.1× the input', () => {
    const cost = estimateCost(table, [
      usage({ model: 'claude-opus-4-8', cacheReadTokens: 1_000_000 }),
    ])
    expect(cost?.usd).toBe(0.5)
  })

  it('finds a model by its id without the date or the context suffix', () => {
    expect(priceOf(table, 'claude-sonnet-5-5-20261001')).toBe(DEFAULT_PRICING['claude-sonnet-5-5'])
    expect(priceOf(table, 'claude-opus-4-6[1m]')).toBe(DEFAULT_PRICING['claude-opus-4-6'])
    // Otro modelo con el mismo prefijo no es el mismo: Opus 5.5 no cobra como Opus 5.
    expect(
      priceOf({ 'claude-opus-5': { input: 5, output: 25 } }, 'claude-opus-5-5'),
    ).toBeUndefined()
    // Bedrock cobra distinto: su id no matchea.
    expect(priceOf(table, 'anthropic.claude-opus-5-5')).toBeUndefined()
  })

  it('a subscription provider is marked as such, not priced', () => {
    expect(
      estimateCost(table, [usage({ scope: SUBSCRIPTION_SCOPE, inputTokens: 1_000_000 })]),
    ).toEqual({ subscription: true })
    expect(
      estimateCost(table, [
        usage({ scope: SUBSCRIPTION_SCOPE, inputTokens: 1_000_000 }),
        usage({ inputTokens: 1_000_000 }),
      ]),
    ).toEqual({ usd: 4, subscription: true })
  })

  it('a model without a price leaves no usd: half a total misleads', () => {
    expect(
      estimateCost(table, [
        usage({ inputTokens: 1_000 }),
        usage({ model: 'gpt-x', inputTokens: 5 }),
      ]),
    ).toEqual({ unpriced_models: ['gpt-x'] })
    expect(estimateCost(table, [])).toBeUndefined()
    expect(estimateCost(table, [usage({})])).toBeUndefined()
  })

  it('runner.yaml overrides a default and adds a model', () => {
    const own = PricingSection.parse({
      'claude-opus-5-5': { input: 1, output: 2 },
      'mi-modelo': { input: 3, output: 4, cacheRead: 0.5, cacheWrite: 6 },
    })
    const mine = pricingTable(own)
    expect(mine['claude-opus-5-5']).toEqual({ input: 1, output: 2 })
    expect(mine['claude-haiku-5-5']).toEqual(DEFAULT_PRICING['claude-haiku-5-5'])
    expect(
      estimateCost(mine, [usage({ model: 'mi-modelo', cacheWriteTokens: 1_000_000 })]),
    ).toEqual({ usd: 6 })
    expect(() => PricingSection.parse({ x: { input: 1 } })).toThrow()
  })

  it('sums the executions of a task with the same rules', () => {
    expect(sumCosts([{ usd: 1.5 }, undefined, { usd: 0.25, subscription: true }])).toEqual({
      usd: 1.75,
      subscription: true,
    })
    expect(sumCosts([{ usd: 1 }, { unpriced_models: ['gpt-x'] }])).toEqual({
      unpriced_models: ['gpt-x'],
    })
    expect(sumCosts([undefined])).toBeUndefined()
  })

  it('tells the assistant the total of a task and that it is an estimate', () => {
    const cost = taskCost([{ cost: { usd: 1 } }, { cost: { usd: 2 } }, {}])
    expect(cost.cost_usd).toBe(3)
    expect(cost.cost_note).toContain('ESTIMADO')
    expect(taskCost([{}])).toEqual({})
  })

  it('writes an amount for a person', () => {
    expect(usdText(1.234)).toBe('~$1.23')
    expect(usdText(0.0042)).toBe('~$0.004')
  })
})
