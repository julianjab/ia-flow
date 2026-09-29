import { describe, expect, it } from 'vitest'
import * as lib from '../index.js'

describe('package entrypoint', () => {
  it('exports the public API', () => {
    expect(lib.AnthropicClient).toBeDefined()
    expect(lib.backoffMs).toBeTypeOf('function')
    expect(lib.AnthropicProvider).toBeDefined()
  })

  it('wires end-to-end through the public API only', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )

    const provider = new lib.AnthropicProvider({
      id: 'anthropic-api',
      model: 'claude-x',
      apiKey: 'sk-test',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.run({
      agentId: 'x',
      prompt: 'hola',
      systemPrompts: [],
      variables: {},
      providerConfig: {},
      mcpServers: [],
      tools: [],
      ctx: {
        event: { type: 'a', payload: {}, occurredAt: new Date().toISOString(), depth: 0 },
        steps: {},
        bus: {} as never,
        pipelineId: 'p',
      },
    })

    expect(result).toEqual({ outcome: 'success', summary: 'ok' })
  })
})
