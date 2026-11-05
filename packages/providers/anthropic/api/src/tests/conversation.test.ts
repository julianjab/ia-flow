import { describe, expect, it, vi } from 'vitest'
import type { AnthropicMessage } from '../AnthropicProvider.js'
import {
  assistantContent,
  awaitsServerCalls,
  dropUnknownToolReferences,
  knownToolNames,
  pairOrphanedServerCalls,
} from '../conversation.js'

const search = {
  type: 'server_tool_use',
  id: 'srvtoolu_1',
  name: 'tool_search_tool_regex',
  input: { query: 'memory' },
}
const searchError = {
  type: 'tool_search_tool_result',
  tool_use_id: 'srvtoolu_1',
  content: { type: 'tool_search_tool_result_error', error_code: 'unavailable' },
}
const thinking = { type: 'thinking', thinking: 'busco', signature: 's' }

/** Una conversación retomada: el turno del asistente quedó cerrado por texto del usuario. */
function closed(content: unknown[]): AnthropicMessage[] {
  return [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content },
    { role: 'user', content: 'Continuá.' },
  ]
}

describe('pairOrphanedServerCalls', () => {
  it('pairs a tool search left without its result in a closed turn (ai-mobile-app#824)', () => {
    const onPair = vi.fn()

    const out = pairOrphanedServerCalls(closed([thinking, search]), onPair)

    expect(out[1]?.content).toEqual([thinking, search, searchError])
    expect(onPair).toHaveBeenCalledWith({
      index: 1,
      paired: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex' }],
    })
  })

  it('pairs the bm25 variant and web search with their own result blocks', () => {
    const out = pairOrphanedServerCalls(
      closed([
        { type: 'server_tool_use', id: 'b1', name: 'tool_search_tool_bm25', input: {} },
        { type: 'server_tool_use', id: 'w1', name: 'web_search', input: {} },
      ]),
    )

    expect(out[1]?.content).toEqual([
      expect.objectContaining({ id: 'b1' }),
      {
        type: 'tool_search_tool_result',
        tool_use_id: 'b1',
        content: { type: 'tool_search_tool_result_error', error_code: 'unavailable' },
      },
      expect.objectContaining({ id: 'w1' }),
      {
        type: 'web_search_tool_result',
        tool_use_id: 'w1',
        content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
      },
    ])
  })

  it('pairs MCP calls and server tools of the same turn, each with its own result', () => {
    const mcp = { type: 'mcp_tool_use', id: 'm1', name: 'issue_read', server_name: 'gh' }

    const out = pairOrphanedServerCalls(closed([search, mcp]))

    expect(
      (out[1]?.content as Array<{ type: string }> | undefined)?.map((block) => block.type),
    ).toEqual(['server_tool_use', 'tool_search_tool_result', 'mcp_tool_use', 'mcp_tool_result'])
  })

  it('leaves a server tool that already has its result alone', () => {
    const messages = closed([
      search,
      {
        type: 'tool_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: { type: 'tool_search_tool_search_result', tool_references: [] },
      },
      { type: 'text', text: 'encontré' },
    ])

    expect(pairOrphanedServerCalls(messages)).toBe(messages)
  })

  it('does not touch a pending server tool in an open turn: after a pause_turn the API runs it', () => {
    const paused: AnthropicMessage[] = [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: [thinking, search] },
    ]

    expect(pairOrphanedServerCalls(paused)).toBe(paused)
  })

  it('does not touch it either when only the tool results of local tools follow', () => {
    const open: AnthropicMessage[] = [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'noop' }, search] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
    ]

    expect(pairOrphanedServerCalls(open)).toBe(open)
  })

  it('drops an unknown server tool it cannot pair, without leaving thinking last', () => {
    const unknown = { type: 'server_tool_use', id: 'x1', name: 'future_tool', input: {} }
    const onPair = vi.fn()

    const out = pairOrphanedServerCalls(
      closed([{ type: 'text', text: 'pruebo' }, thinking, unknown]),
      onPair,
    )

    expect(out[1]?.content).toEqual([{ type: 'text', text: 'pruebo' }])
    expect(onPair.mock.calls[0]?.[0].paired).toEqual([
      { type: 'server_tool_use', id: 'x1', name: 'future_tool', dropped: true },
    ])
  })

  it('never leaves a closed turn empty after dropping its only call', () => {
    const out = pairOrphanedServerCalls(
      closed([{ type: 'server_tool_use', id: 'x1', name: 'future_tool', input: {} }]),
    )

    expect(out[1]?.content).toEqual([{ type: 'text', text: expect.any(String) }])
  })
})

describe('awaitsServerCalls', () => {
  it('a pending tool search behind the tool results keeps text out of the turn', () => {
    expect(
      awaitsServerCalls([
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'noop' }, search] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
      ]),
    ).toBe(true)
  })

  it('an answered tool search does not', () => {
    expect(
      awaitsServerCalls([
        { role: 'user', content: 'hola' },
        {
          role: 'assistant',
          content: [search, searchError, { type: 'tool_use', id: 't1', name: 'noop' }],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
      ]),
    ).toBe(false)
  })
})

describe('assistantContent', () => {
  it('pairs a dangling tool search of a turn about to be closed', () => {
    expect(assistantContent([search, thinking])).toEqual([search, searchError])
  })
})

describe('dropUnknownToolReferences', () => {
  const found = (...names: string[]) => ({
    type: 'tool_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: {
      type: 'tool_search_tool_search_result',
      tool_references: names.map((tool_name) => ({ type: 'tool_reference', tool_name })),
    },
  })

  it('drops the references to tools no longer in the request (ai-development-flow#822)', () => {
    const onDrop = vi.fn()
    const messages = closed([search, found('memory-mcp__read_graph', 'github-mcp__get_me')])

    const out = dropUnknownToolReferences(messages, new Set(['github-mcp__get_me']), onDrop)

    expect((out[1]?.content as unknown[] | undefined)?.[1]).toEqual(found('github-mcp__get_me'))
    expect(onDrop).toHaveBeenCalledWith({ index: 1, tools: ['memory-mcp__read_graph'] })
  })

  it('returns the same conversation when every reference is known, or on an error result', () => {
    const messages = closed([search, found('github-mcp__get_me'), search, searchError])

    expect(dropUnknownToolReferences(messages, new Set(['github-mcp__get_me']))).toBe(messages)
  })
})

describe('knownToolNames', () => {
  it('lists the names of the request tools', () => {
    expect(
      knownToolNames([
        { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
        { name: 'github-mcp__get_me', defer_loading: true },
      ]),
    ).toEqual(new Set(['tool_search_tool_regex', 'github-mcp__get_me']))
  })

  it('does not know them when a connector toolset lists its own server-side', () => {
    expect(knownToolNames([{ type: 'mcp_toolset', mcp_server_name: 'gh' }])).toBeUndefined()
  })
})
