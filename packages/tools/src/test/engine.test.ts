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
  it('returns truncated=true when stop_reason is pause_turn (task_budget)', async () => {
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

  it('returns truncated=false and stopReason=end_turn on normal completion', async () => {
    const fetchApi = async () => endTurnResponse('ok')
    const result = await executeLoop(fetchApi, [{ role: 'user', content: 'x' }], BASE_CTX)
    expect(result.truncated).toBe(false)
    expect(result.stopReason).toBe('end_turn')
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
