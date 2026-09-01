import { describe, expect, it } from 'vitest'
import { estimateCostUsd, modelPricing } from '../pricing'

describe('modelPricing', () => {
  it('matchea por prefijo, así un id con fecha encuentra su precio', () => {
    expect(modelPricing('claude-haiku-4-5-20251001')).toEqual(modelPricing('claude-haiku-4-5'))
  })

  it('prefiere el prefijo más específico', () => {
    // `claude-opus-4` (generación vieja, más cara) no debe tapar a 4-6.
    expect(modelPricing('claude-opus-4-6')?.input).toBe(5)
    expect(modelPricing('claude-opus-4-20250514')?.input).toBe(15)
  })

  it('devuelve undefined para un modelo desconocido o vacío', () => {
    expect(modelPricing('gpt-5')).toBeUndefined()
    expect(modelPricing(null)).toBeUndefined()
    expect(modelPricing('')).toBeUndefined()
  })
})

describe('estimateCostUsd', () => {
  const usage = {
    tokensIn: 1_000_000,
    tokensOut: 100_000,
    cacheReadTokens: 2_000_000,
    cacheCreationTokens: 500_000,
  }

  it('suma cada tipo de token a su tarifa', () => {
    // Sonnet 5: 2 + 10*0.1 + 0.2*2 + 2.5*0.5 = 2 + 1 + 0.4 + 1.25
    expect(estimateCostUsd('claude-sonnet-5', usage)).toBeCloseTo(4.65, 6)
  })

  it('es null, no 0, cuando el modelo no tiene precio', () => {
    expect(estimateCostUsd('desconocido', usage)).toBeNull()
    expect(estimateCostUsd(null, usage)).toBeNull()
  })

  it('da 0 para un run sin tokens de un modelo conocido', () => {
    expect(
      estimateCostUsd('claude-haiku-4-5', {
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(0)
  })
})
