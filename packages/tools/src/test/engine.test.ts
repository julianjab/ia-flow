import { afterEach, describe, expect, it } from 'bun:test'
import type { ToolContext } from '../contract.js'
import {
  executeLoop,
  getAllTools,
  getTool,
  getToolDefinitions,
  registerTool,
  resolveAliases,
  resolveTools,
} from '../engine.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const BASE_CTX: ToolContext = { repoPaths: {} }

function endTurnResponse(text = 'done'): unknown {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
}

function toolUseResponse(name: string, input: unknown, id = 'tu_1'): unknown {
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] }
}

// ─── registerTool / getTool / getToolDefinitions ──────────────────────────────

describe('tool registry', () => {
  it('registers a tool and retrieves it by name', () => {
    registerTool({
      name: '__test_echo__',
      description: 'Echo tool',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      execute: async (input: any) => input.msg as string,
    })
    const tool = getTool('__test_echo__')
    expect(tool).toBeDefined()
    expect(tool!.name).toBe('__test_echo__')
  })

  it('returns undefined for unknown tool', () => {
    expect(getTool('no_such_tool_xyz')).toBeUndefined()
  })

  it('includes registered tool in getToolDefinitions()', () => {
    registerTool({
      name: '__test_list__',
      description: 'Listed',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'ok',
    })
    const names = getToolDefinitions().map((d) => d.name)
    expect(names).toContain('__test_list__')
  })

  it('resolveAliases maps legacy names to canonical ids and dedupes', () => {
    registerTool({
      name: '__test_canon__',
      description: 'c',
      input_schema: { type: 'object', properties: {} },
      aliases: ['__test_alias1__', '__test_alias2__'],
      execute: async () => 'ok',
    })
    expect(resolveAliases(['__test_alias1__'])).toEqual(['__test_canon__'])
    expect(resolveAliases(['__test_alias1__', '__test_canon__', '__test_alias2__'])).toEqual([
      '__test_canon__',
    ])
    expect(resolveAliases(['__unknown__'])).toEqual(['__unknown__'])
  })

  it('resolveTools honors aliases in toolNames allow-list', () => {
    registerTool({
      name: '__test_aliased__',
      description: 'a',
      input_schema: { type: 'object', properties: {} },
      aliases: ['__test_aliased_legacy__'],
      execute: async () => 'ok',
    })
    const tools = resolveTools({ toolNames: ['__test_aliased_legacy__'] })
    expect(tools.some((t) => t.name === '__test_aliased__')).toBe(true)
  })

  it('getAllTools returns the full registry', () => {
    const all = getAllTools()
    expect(all.length).toBeGreaterThan(0)
    expect(all.every((t) => typeof t.name === 'string')).toBe(true)
  })

  it('getToolDefinitions returns name, description, input_schema for each tool', () => {
    registerTool({
      name: '__test_schema__',
      description: 'Has schema',
      input_schema: { type: 'object', properties: { x: { type: 'number' } } },
      execute: async () => 'ok',
    })
    const def = getToolDefinitions().find((d) => d.name === '__test_schema__')!
    expect(def.description).toBe('Has schema')
    expect((def.input_schema as any).properties.x.type).toBe('number')
  })
})

// ─── executeLoop — end_turn immediately ──────────────────────────────────────

describe('executeLoop — end_turn', () => {
  it('returns text and iters=1 when API responds with end_turn', async () => {
    const fetchApi = async () => endTurnResponse('hello')
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'hi' }], BASE_CTX)
    expect(result.text).toBe('hello')
    expect(result.iters).toBe(1)
  })

  it('concatenates multiple text blocks', async () => {
    const fetchApi = async () => ({
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'foo' },
        { type: 'text', text: 'bar' },
      ],
    })
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX)
    expect(result.text).toBe('foobar')
  })

  it('returns empty string when no text blocks on end_turn', async () => {
    const fetchApi = async () => ({ stop_reason: 'end_turn', content: [] })
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX)
    expect(result.text).toBe('')
  })
})

// ─── executeLoop — tool use ───────────────────────────────────────────────────

describe('executeLoop — tool use', () => {
  it('executes a registered tool and continues to end_turn', async () => {
    registerTool({
      name: '__test_add__',
      description: 'Add',
      input_schema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
      },
      execute: async (input: any) => String((input.a as number) + (input.b as number)),
    })

    let call = 0
    const fetchApi = async () => {
      call++
      if (call === 1) return toolUseResponse('__test_add__', { a: 2, b: 3 })
      return endTurnResponse('sum was 5')
    }

    const toolCalls: string[] = []
    const toolResults: string[] = []
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'add 2+3' }], BASE_CTX, {
      onToolCall: (name) => toolCalls.push(name),
      onToolResult: (_name, res) => toolResults.push(res),
    })

    expect(result.text).toBe('sum was 5')
    expect(result.iters).toBe(2)
    expect(toolCalls).toEqual(['__test_add__'])
    expect(toolResults).toEqual(['5'])
  })

  it('returns error string for unknown tools without throwing', async () => {
    let call = 0
    const fetchApi = async () => {
      call++
      if (call === 1) return toolUseResponse('unknown_tool_abc', {})
      return endTurnResponse('ok')
    }

    const results: string[] = []
    await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX, {
      onToolResult: (_name, r) => results.push(r),
    })

    expect(results[0]).toContain("tool 'unknown_tool_abc' not found")
  })

  it('truncates oversized tool_result before it enters the message history', async () => {
    const HUGE = 'x'.repeat(500_000)
    registerTool({
      name: '__test_huge__',
      description: 'Huge output',
      input_schema: { type: 'object', properties: {} },
      execute: async () => HUGE,
    })

    let call = 0
    let seenToolResultBytes = 0
    const fetchApi = async (messages: any[]) => {
      call++
      if (call === 1) return toolUseResponse('__test_huge__', {}, 'tu_huge')
      // On the second call, inspect the tool_result content pushed to history.
      const lastUser = messages[messages.length - 1]
      const tr = (lastUser.content as any[])[0]
      seenToolResultBytes = (tr.content as string).length
      return endTurnResponse('ok')
    }

    await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX)
    expect(seenToolResultBytes).toBeLessThan(HUGE.length)
    expect(seenToolResultBytes).toBeLessThanOrEqual(100_000 + 200) // cap + truncation marker
  })

  it('returns error string when tool.execute throws', async () => {
    registerTool({
      name: '__test_throw__',
      description: 'Throws',
      input_schema: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('boom')
      },
    })

    let call = 0
    const fetchApi = async () => {
      call++
      if (call === 1) return toolUseResponse('__test_throw__', {})
      return endTurnResponse('ok')
    }

    const results: string[] = []
    await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX, {
      onToolResult: (_name, r) => results.push(r),
    })

    expect(results[0]).toContain('boom')
  })
})

// ─── executeLoop — task budget / truncation ─────────────────────────────────

describe('executeLoop — truncation signals', () => {
  it('returns truncated=true on first pause_turn when maxPauseTurnRetries is unset (default 0)', async () => {
    const fetchApi = async () => ({
      stop_reason: 'pause_turn',
      content: [{ type: 'text', text: 'partial progress' }],
    })
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX)
    expect(result.text).toBe('partial progress')
    expect(result.truncated).toBe(true)
    expect(result.stopReason).toBe('pause_turn')
  })

  it('returns truncated=true when stop_reason is max_tokens', async () => {
    const fetchApi = async () => ({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'partial' }],
    })
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX)
    expect(result.truncated).toBe(true)
    expect(result.stopReason).toBe('max_tokens')
  })

  it('returns truncated=true when stop_reason is model_context_window_exceeded', async () => {
    const fetchApi = async () => ({
      stop_reason: 'model_context_window_exceeded',
      content: [{ type: 'text', text: 'partial' }],
    })
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX)
    expect(result.truncated).toBe(true)
    expect(result.stopReason).toBe('model_context_window_exceeded')
  })

  it('returns truncated=true when stop_reason is refusal', async () => {
    const fetchApi = async () => ({
      stop_reason: 'refusal',
      content: [],
    })
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX)
    expect(result.truncated).toBe(true)
    expect(result.stopReason).toBe('refusal')
  })

  it('returns truncated=false and stopReason=end_turn on normal completion', async () => {
    const fetchApi = async () => endTurnResponse('ok')
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX)
    expect(result.truncated).toBe(false)
    expect(result.stopReason).toBe('end_turn')
  })
})

// ─── executeLoop — pause_turn retry ────────────────────────────────────────

describe('executeLoop — pause_turn retry', () => {
  it('resends the unchanged message list and succeeds within maxPauseTurnRetries', async () => {
    const calls: unknown[][] = []
    let call = 0
    const fetchApi = async (messages: unknown[]) => {
      calls.push(structuredClone(messages))
      call++
      if (call < 3) {
        return { stop_reason: 'pause_turn', content: [{ type: 'text', text: `paused ${call}` }] }
      }
      return endTurnResponse('resumed')
    }
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX, {
      maxPauseTurnRetries: 5,
    })
    expect(result.truncated).toBe(false)
    expect(result.stopReason).toBe('end_turn')
    // Text generated in the paused turns before the final resume must not
    // be dropped — only the last response's blocks would otherwise survive.
    expect(result.text).toBe('paused 1paused 2resumed')
    expect(calls.length).toBe(3)
    // Second call must be exactly [user, assistant(paused #1)] — no new
    // user message injected, no history stripped, nothing appended beyond
    // the paused assistant turn from the previous response.
    expect(calls[1]).toEqual([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'text', text: 'paused 1' }] },
    ])
  })

  it('gives up and returns truncated=true after exhausting maxPauseTurnRetries', async () => {
    let call = 0
    const fetchApi = async () => {
      call++
      return { stop_reason: 'pause_turn', content: [{ type: 'text', text: `paused ${call}` }] }
    }
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX, {
      maxPauseTurnRetries: 2,
    })
    expect(result.truncated).toBe(true)
    expect(result.stopReason).toBe('pause_turn')
    // 1 initial call + 2 retries = 3 total
    expect(call).toBe(3)
    // Even giving up truncated, text from every paused turn is preserved —
    // not just the last one.
    expect(result.text).toBe('paused 1paused 2paused 3')
  })

  it('executes a pending client tool_use instead of blindly resending when it shares a pause_turn response', async () => {
    registerTool({
      name: '__test_pause_tool_use__',
      description: 'Echo',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async (input: any) => String(input.msg),
    })
    const calls: unknown[][] = []
    let call = 0
    const fetchApi = async (messages: unknown[]) => {
      calls.push(structuredClone(messages))
      call++
      if (call === 1) {
        // Anthropic's docs say this combination shouldn't happen, but the
        // loop must not 400 the next request if it ever does: a pending
        // client tool_use has to get its tool_result before anything else.
        return {
          stop_reason: 'pause_turn',
          content: [
            { type: 'tool_use', id: 'tu_1', name: '__test_pause_tool_use__', input: { msg: 'hi' } },
          ],
        }
      }
      return endTurnResponse('done')
    }
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX, {
      maxPauseTurnRetries: 5,
    })
    expect(result.truncated).toBe(false)
    expect(result.stopReason).toBe('end_turn')
    expect(calls.length).toBe(2)
    // The follow-up request must carry the tool_result for tu_1 — not just
    // the unchanged paused assistant turn.
    expect(calls[1][2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'hi' }],
    })
  })
})

// ─── executeLoop — max_tokens/tool_use retry ───────────────────────────────

describe('executeLoop — max_tokens truncated tool_use retry', () => {
  it('drops the corrupted turn, retries once with bumpMaxTokens, and continues on tool_use', async () => {
    registerTool({
      name: '__test_retry_echo__',
      description: 'Echo',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async (input: any) => String(input.msg),
    })
    const calls: Array<{ messages: unknown[]; overrides: unknown }> = []
    let call = 0
    const fetchApi = async (messages: unknown[], overrides?: unknown) => {
      calls.push({ messages: structuredClone(messages), overrides })
      call++
      if (call === 1) {
        // Cut off mid-tool_use — the case worth retrying.
        return {
          stop_reason: 'max_tokens',
          content: [
            { type: 'tool_use', id: 'tu_1', name: '__test_retry_echo__', input: { msg: 'hi' } },
          ],
        }
      }
      if (call === 2) {
        return toolUseResponse('__test_retry_echo__', { msg: 'hi' })
      }
      return endTurnResponse('done')
    }
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX, {
      retryTruncatedToolUse: true,
    })
    expect(result.truncated).toBe(false)
    expect(result.stopReason).toBe('end_turn')
    expect(calls.length).toBe(3)
    // The retry call gets the bump flag and does NOT include the corrupted
    // max_tokens turn — just the original messages, unchanged.
    expect(calls[1].overrides).toEqual({ bumpMaxTokens: true })
    expect(calls[1].messages).toEqual([{ role: 'user', content: 'x' }])
  })

  it('returns truncated=true without retrying when retryTruncatedToolUse is unset (default false)', async () => {
    let call = 0
    const fetchApi = async () => {
      call++
      return {
        stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', id: 'tu_1', name: '__test_echo__', input: {} }],
      }
    }
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX)
    expect(result.truncated).toBe(true)
    expect(result.stopReason).toBe('max_tokens')
    expect(call).toBe(1)
  })

  it('does not retry when max_tokens is not caused by a cut-off tool_use', async () => {
    let call = 0
    const fetchApi = async () => {
      call++
      return { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] }
    }
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX, {
      retryTruncatedToolUse: true,
    })
    expect(result.truncated).toBe(true)
    expect(call).toBe(1)
  })
})

// ─── executeLoop — unexpected stop_reason ─────────────────────────────────────

describe('executeLoop — unexpected stop_reason', () => {
  it('returns whatever text is present on unexpected stop_reason', async () => {
    const fetchApi = async () => ({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'partial output' }],
    })
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX)
    expect(result.text).toBe('partial output')
    expect(result.iters).toBe(1)
  })
})

// ─── executeLoop — onToolCall / onToolResult callbacks ───────────────────────

describe('executeLoop — parallel tool execution', () => {
  it('executes multiple tool_use blocks from one response in parallel', async () => {
    registerTool({
      name: '__test_upper__',
      description: 'Uppercase',
      input_schema: { type: 'object', properties: { s: { type: 'string' } } },
      execute: async (input: any) => (input.s as string).toUpperCase(),
    })

    let call = 0
    const fetchApi = async () => {
      call++
      if (call === 1) {
        return {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'tu_a', name: '__test_upper__', input: { s: 'hello' } },
            { type: 'tool_use', id: 'tu_b', name: '__test_upper__', input: { s: 'world' } },
          ],
        }
      }
      return endTurnResponse('done')
    }

    const results: string[] = []
    await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX, {
      onToolResult: (_name, r) => results.push(r),
    })

    expect(results).toContain('HELLO')
    expect(results).toContain('WORLD')
  })
})

// ─── Run metrics (usage / toolCalls / toolErrors) ─────────────────────────────

describe('executeLoop — run metrics', () => {
  it('sums usage across every iteration, not just the last response', async () => {
    registerTool({
      name: '__metrics_ok__',
      description: 'ok',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'fine',
    })
    const responses: unknown[] = [
      {
        ...(toolUseResponse('__metrics_ok__', {}) as object),
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 2,
        },
      },
      { ...(endTurnResponse() as object), usage: { input_tokens: 40, output_tokens: 7 } },
    ]
    let i = 0
    const result = await executeLoop(async () => responses[i++], [], BASE_CTX)

    expect(result.iters).toBe(2)
    expect(result.usage).toEqual({
      inputTokens: 140,
      outputTokens: 17,
      cacheReadTokens: 5,
      cacheCreationTokens: 2,
    })
    expect(result.toolCalls).toBe(1)
    expect(result.toolErrors).toBe(0)
  })

  it('zeroes usage when the API returns no usage block', async () => {
    const result = await executeLoop(async () => endTurnResponse(), [], BASE_CTX)
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
  })

  it('counts a throwing tool and an unknown tool as tool errors', async () => {
    registerTool({
      name: '__metrics_boom__',
      description: 'throws',
      input_schema: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('boom')
      },
    })
    const responses: unknown[] = [
      toolUseResponse('__metrics_boom__', {}, 'tu_a'),
      toolUseResponse('__no_such_tool_at_all__', {}, 'tu_b'),
      endTurnResponse(),
    ]
    let i = 0
    const result = await executeLoop(async () => responses[i++], [], BASE_CTX)

    expect(result.toolCalls).toBe(2)
    expect(result.toolErrors).toBe(2)
  })

  it('reports metrics on a truncated run too', async () => {
    const result = await executeLoop(
      async () => ({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'partial' }],
        usage: { input_tokens: 9, output_tokens: 3 },
      }),
      [],
      BASE_CTX,
    )
    expect(result.truncated).toBe(true)
    expect(result.usage.inputTokens).toBe(9)
    expect(result.toolCalls).toBe(0)
  })
})
