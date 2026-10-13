import { describe, expect, test } from 'bun:test'
import { parseConfig } from './config.js'

const valid = { LLM_GATEWAY_TOKEN: 'a'.repeat(24), CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-test' }

describe('parseConfig', () => {
  test('aplica los defaults: sólo loopback y puerto 4141', () => {
    const config = parseConfig(valid)
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(4141)
    expect(config.defaultModel).toBe(config.models[0])
    expect(config.defaultMaxTokens).toBe(4096)
  })

  test('lee el system prompt opcional del entorno', () => {
    expect(parseConfig(valid).systemPrompt).toBe('')
    expect(parseConfig({ ...valid, LLM_GATEWAY_SYSTEM_PROMPT: ' sé breve ' }).systemPrompt).toBe(
      'sé breve',
    )
  })

  test('dropSampling sólo con 1 o true', () => {
    expect(parseConfig(valid).dropSampling).toBe(false)
    expect(parseConfig({ ...valid, LLM_GATEWAY_DROP_SAMPLING: 'TRUE' }).dropSampling).toBe(true)
    expect(parseConfig({ ...valid, LLM_GATEWAY_DROP_SAMPLING: '0' }).dropSampling).toBe(false)
  })

  test('toma modelos y puerto del entorno', () => {
    const config = parseConfig({
      ...valid,
      LLM_GATEWAY_MODELS: ' a , b ',
      LLM_GATEWAY_DEFAULT_MODEL: 'b',
      LLM_GATEWAY_PORT: '9000',
    })
    expect(config.models).toEqual(['a', 'b'])
    expect(config.defaultModel).toBe('b')
    expect(config.port).toBe(9000)
  })

  test('falla sin token, con token corto o sin key de Anthropic', () => {
    expect(() => parseConfig({ CLAUDE_CODE_OAUTH_TOKEN: 'k' })).toThrow('LLM_GATEWAY_TOKEN')
    expect(() => parseConfig({ ...valid, LLM_GATEWAY_TOKEN: 'corto' })).toThrow('al menos')
    expect(() => parseConfig({ LLM_GATEWAY_TOKEN: valid.LLM_GATEWAY_TOKEN })).toThrow(
      'CLAUDE_CODE_OAUTH_TOKEN',
    )
  })

  test('rechaza un puerto que no es entero positivo', () => {
    expect(() => parseConfig({ ...valid, LLM_GATEWAY_PORT: 'abc' })).toThrow('LLM_GATEWAY_PORT')
  })
})
