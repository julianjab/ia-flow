import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderConfig } from '@ia-flow/shared'
import { DEFAULT_ANTHROPIC_SETTINGS, DEFAULT_PROVIDER_CONFIG } from '../contract.js'

// Métricas nulas para los fakes del loop: el contrato de `LoopResult` las
// exige, y ninguno de estos casos las mira.
const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}
import type { LoadProviderConfig, ProviderInput, ToolExecutionPort } from '../contract.js'
import { AnthropicApiProvider, UpstreamAbortError } from './provider.js'
import type { AnthropicApiProviderDeps } from './provider.js'

const originalFetch = globalThis.fetch
const originalOauth = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
const originalApiKey = Bun.env.ANTHROPIC_API_KEY

beforeEach(() => {
  Bun.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token'
  delete Bun.env.ANTHROPIC_API_KEY
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalOauth === undefined) delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  else Bun.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth
  if (originalApiKey === undefined) delete Bun.env.ANTHROPIC_API_KEY
  else Bun.env.ANTHROPIC_API_KEY = originalApiKey
})

// ─── SSE fixture helpers ──────────────────────────────────────────────────

type SseEvent = { event?: string; data: unknown }

function encodeEvent(evt: SseEvent): string {
  const lines: string[] = []
  if (evt.event) lines.push(`event: ${evt.event}`)
  lines.push(`data: ${JSON.stringify(evt.data)}`)
  return `${lines.join('\n')}\n\n`
}

/** Builds a streaming Response whose body is chunked exactly as given —
 *  each entry in `chunks` becomes one `controller.enqueue()` call, so tests
 *  can force an SSE event to split across two reads. */
function sseResponseFromChunks(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

function sseResponse(events: SseEvent[], status = 200): Response {
  return sseResponseFromChunks(events.map(encodeEvent), status)
}

/** A stream that emits a few chunks then errors, simulating a mid-generation
 *  connection reset — the exact failure mode the streaming rewrite defends
 *  against. */
function sseResponseThatResets(events: SseEvent[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) controller.enqueue(encoder.encode(encodeEvent(evt)))
      controller.error(new Error('socket hang up'))
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const endTurnEvents: SseEvent[] = [
  {
    event: 'message_start',
    data: { message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 10 } } },
  },
  { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
  {
    event: 'content_block_delta',
    data: { index: 0, delta: { type: 'text_delta', text: 'Hola ' } },
  },
  {
    event: 'content_block_delta',
    data: { index: 0, delta: { type: 'text_delta', text: 'mundo' } },
  },
  { event: 'content_block_stop', data: { index: 0 } },
  {
    event: 'message_delta',
    data: { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
  },
  { event: 'message_stop', data: {} },
]

// ─── Test harness ──────────────────────────────────────────────────────────

/** Fake tool-execution loop: makes exactly one fetchApi() call and surfaces
 *  the reassembled response object untouched, so tests can assert on the
 *  exact shape `readAnthropicSseStream` (private) produced without exporting
 *  it. Mirrors just enough of the real engine.ts loop (packages/tools) to
 *  drive `AnthropicApiProvider.run` end-to-end. */
function makeToolExecution(capture: { response?: Record<string, unknown> } = {}): {
  port: ToolExecutionPort
  capture: { response?: Record<string, unknown> }
} {
  const port: ToolExecutionPort = {
    getToolDefinitions: () => [],
    executeLoop: async (fetchApi, initialMessages) => {
      const response = (await fetchApi(initialMessages)) as Record<string, unknown>
      capture.response = response
      const content = (response.content as Array<Record<string, unknown>> | undefined) ?? []
      const text = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('')
      const stopReason = (response.stop_reason as string) ?? 'unknown'
      return {
        text,
        iters: 1,
        stopReason,
        truncated: stopReason !== 'end_turn',
        usage: EMPTY_USAGE,
        toolCalls: 0,
        toolErrors: 0,
      }
    },
  }
  return { port, capture }
}

const noopLog: AnthropicApiProviderDeps['log'] = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
}

function configWith(
  overrides: Partial<typeof DEFAULT_ANTHROPIC_SETTINGS> = {},
): LoadProviderConfig {
  const cfg: ProviderConfig = {
    ...DEFAULT_PROVIDER_CONFIG,
    anthropicApi: { ...DEFAULT_ANTHROPIC_SETTINGS, ...overrides },
  }
  return async () => cfg
}

function baseInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    step: 'refine-functional',
    taskId: 'task-1',
    taskTitle: 'Add login',
    taskDescription: 'desc',
    taskType: 'feat',
    repos: [],
    repoPaths: {},
    prompt: 'hello',
    ...overrides,
  }
}

function makeProvider(
  loadProviderConfig: LoadProviderConfig,
  capture: { response?: Record<string, unknown> } = {},
): { provider: AnthropicApiProvider; capture: { response?: Record<string, unknown> } } {
  const { port, capture: cap } = makeToolExecution(capture)
  const provider = new AnthropicApiProvider({
    toolExecution: port,
    loadProviderConfig,
    log: noopLog,
    skipContextLog: true,
  })
  return { provider, capture: cap }
}

// ─── Streaming reassembly ───────────────────────────────────────────────────

describe('AnthropicApiProvider.run — SSE reassembly (default stream: true)', () => {
  it('reassembles text deltas and stop_reason from a streamed response', async () => {
    globalThis.fetch = (async () => sseResponse(endTurnEvents)) as unknown as typeof fetch
    const { provider, capture } = makeProvider(configWith())

    const out = await provider.run(baseInput())

    expect(out.content).toBe('Hola mundo')
    expect(out.stopReason).toBe('end_turn')
    expect(out.truncated).toBe(false)
    expect(capture.response?.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  it('sends stream: true in the request body by default', async () => {
    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      return sseResponse(endTurnEvents)
    }) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    await provider.run(baseInput())

    expect(sentBody.stream).toBe(true)
  })

  it('reassembles a tool_use block whose input arrives via input_json_delta', async () => {
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: { id: 'msg_2' } } },
      {
        event: 'content_block_start',
        data: {
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} },
        },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' } } },
    ]
    globalThis.fetch = (async () => sseResponse(events)) as unknown as typeof fetch
    const { provider, capture } = makeProvider(configWith())

    await provider.run(baseInput())

    const block = (capture.response?.content as Array<Record<string, unknown>>)[0]
    expect(block.type).toBe('tool_use')
    expect(block.input).toEqual({ path: 'a.ts' })
  })

  it('defaults tool_use input to {} when no input_json_delta ever arrives', async () => {
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: {} } },
      {
        event: 'content_block_start',
        data: {
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_2', name: 'noop', input: {} },
        },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' } } },
    ]
    globalThis.fetch = (async () => sseResponse(events)) as unknown as typeof fetch
    const { provider, capture } = makeProvider(configWith())

    await provider.run(baseInput())

    const block = (capture.response?.content as Array<Record<string, unknown>>)[0]
    expect(block.input).toEqual({})
  })

  it('falls back to {} when accumulated tool_use JSON is malformed', async () => {
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: {} } },
      {
        event: 'content_block_start',
        data: {
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_3', name: 'broken', input: {} },
        },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'input_json_delta', partial_json: '{not json' } },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' } } },
    ]
    globalThis.fetch = (async () => sseResponse(events)) as unknown as typeof fetch
    const { provider, capture } = makeProvider(configWith())

    await provider.run(baseInput())

    const block = (capture.response?.content as Array<Record<string, unknown>>)[0]
    expect(block.input).toEqual({})
  })

  it('reassembles a remote-MCP mcp_tool_use block (github-mcp) whose input streams via input_json_delta', async () => {
    // Remote MCP tool calls (mcp_servers, e.g. the github-mcp agents use)
    // come back as `mcp_tool_use`, not `tool_use` — a distinct content
    // block type per Anthropic's MCP connector docs. Its `input` streams
    // the same way, so the reassembly must not hardcode `type: 'tool_use'`.
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: {} } },
      {
        event: 'content_block_start',
        data: {
          index: 0,
          content_block: {
            type: 'mcp_tool_use',
            id: 'mcptoolu_1',
            name: 'get_issue',
            server_name: 'github-mcp',
            input: {},
          },
        },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'input_json_delta', partial_json: '{"issue_number":' } },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'input_json_delta', partial_json: '42}' } },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' } } },
    ]
    globalThis.fetch = (async () => sseResponse(events)) as unknown as typeof fetch
    const { provider, capture } = makeProvider(configWith())

    await provider.run(baseInput())

    const block = (capture.response?.content as Array<Record<string, unknown>>)[0]
    expect(block.type).toBe('mcp_tool_use')
    expect(block.server_name).toBe('github-mcp')
    expect(block.input).toEqual({ issue_number: 42 })
  })

  it('passes an mcp_tool_result block through untouched (server-computed, no input to stream)', async () => {
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: {} } },
      {
        event: 'content_block_start',
        data: {
          index: 0,
          content_block: {
            type: 'mcp_tool_result',
            tool_use_id: 'mcptoolu_1',
            is_error: false,
            content: [{ type: 'text', text: 'issue body' }],
          },
        },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' } } },
    ]
    globalThis.fetch = (async () => sseResponse(events)) as unknown as typeof fetch
    const { provider, capture } = makeProvider(configWith())

    await provider.run(baseInput())

    const block = (capture.response?.content as Array<Record<string, unknown>>)[0]
    expect(block).toEqual({
      type: 'mcp_tool_result',
      tool_use_id: 'mcptoolu_1',
      is_error: false,
      content: [{ type: 'text', text: 'issue body' }],
    })
  })

  it('reassembles thinking blocks (thinking_delta + signature_delta)', async () => {
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: {} } },
      {
        event: 'content_block_start',
        data: { index: 0, content_block: { type: 'thinking', thinking: '' } },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'thinking_delta', thinking: 'pensando ' } },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'thinking_delta', thinking: 'más' } },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      {
        event: 'content_block_start',
        data: { index: 1, content_block: { type: 'text', text: '' } },
      },
      {
        event: 'content_block_delta',
        data: { index: 1, delta: { type: 'text_delta', text: 'ok' } },
      },
      { event: 'content_block_stop', data: { index: 1 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' } } },
    ]
    globalThis.fetch = (async () => sseResponse(events)) as unknown as typeof fetch
    const { provider, capture } = makeProvider(configWith())

    const out = await provider.run(baseInput())

    const blocks = capture.response?.content as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'pensando más', signature: 'sig-abc' })
    expect(out.content).toBe('ok')
  })

  it('ignores a content_block_delta for an index with no matching content_block_start', async () => {
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: {} } },
      // No content_block_start for index 0 — the delta must be a no-op.
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'text_delta', text: 'ghost' } },
      },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' } } },
    ]
    globalThis.fetch = (async () => sseResponse(events)) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    const out = await provider.run(baseInput())

    expect(out.content).toBe('')
  })

  it('ignores unknown/ping event types without throwing', async () => {
    const events: SseEvent[] = [{ event: 'ping', data: { type: 'ping' } }, ...endTurnEvents]
    globalThis.fetch = (async () => sseResponse(events)) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    const out = await provider.run(baseInput())

    expect(out.content).toBe('Hola mundo')
  })

  it('merges usage fields across multiple message_delta events', async () => {
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: { usage: { input_tokens: 3 } } } },
      {
        event: 'content_block_start',
        data: { index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'text_delta', text: 'x' } },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: {}, usage: { output_tokens: 1 } } },
      {
        event: 'message_delta',
        data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      },
    ]
    globalThis.fetch = (async () => sseResponse(events)) as unknown as typeof fetch
    const { provider, capture } = makeProvider(configWith())

    await provider.run(baseInput())

    expect(capture.response?.usage).toEqual({ input_tokens: 3, output_tokens: 2 })
  })

  it('reassembles correctly when a single SSE event is split across stream chunks', async () => {
    const raw = endTurnEvents.map(encodeEvent).join('')
    const mid = Math.floor(raw.length / 2)
    globalThis.fetch = (async () =>
      sseResponseFromChunks([raw.slice(0, mid), raw.slice(mid)])) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    const out = await provider.run(baseInput())

    expect(out.content).toBe('Hola mundo')
    expect(out.stopReason).toBe('end_turn')
  })
})

// ─── Error classification ──────────────────────────────────────────────────

describe('AnthropicApiProvider.run — error classification', () => {
  it('wraps a connection-level fetch failure as UpstreamAbortError', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    await expect(provider.run(baseInput())).rejects.toBeInstanceOf(UpstreamAbortError)
  })

  it('wraps a mid-stream reset (after headers) as UpstreamAbortError', async () => {
    globalThis.fetch = (async () =>
      sseResponseThatResets([
        { event: 'message_start', data: { message: {} } },
        {
          event: 'content_block_start',
          data: { index: 0, content_block: { type: 'text', text: '' } },
        },
      ])) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    await expect(provider.run(baseInput())).rejects.toBeInstanceOf(UpstreamAbortError)
  })

  it('wraps an in-stream `error` event as UpstreamAbortError', async () => {
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: {} } },
      { event: 'error', data: { error: { type: 'overloaded_error', message: 'Overloaded' } } },
    ]
    globalThis.fetch = (async () => sseResponse(events)) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    await expect(provider.run(baseInput())).rejects.toThrow(/stream error/)
  })

  it('throws a plain Error (not UpstreamAbortError) for a null streaming body', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    let caught: unknown
    try {
      await provider.run(baseInput())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(UpstreamAbortError)
    expect((caught as Error).message).toContain('no body')
  })

  it('throws a plain Error (not UpstreamAbortError) for a non-ok HTTP response', async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":{"message":"overloaded"}}', {
        status: 529,
      })) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    let caught: unknown
    try {
      await provider.run(baseInput())
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBeInstanceOf(UpstreamAbortError)
    expect((caught as Error).message).toContain('Anthropic API 529')
  })

  it('rethrows untouched when the caller already aborted the connection attempt', async () => {
    const controller = new AbortController()
    controller.abort()
    globalThis.fetch = (async () => {
      const e = new DOMException('The operation was aborted.', 'AbortError')
      throw e
    }) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    let caught: unknown
    try {
      await provider.run(baseInput({ signal: controller.signal }))
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBeInstanceOf(UpstreamAbortError)
    expect((caught as DOMException).name).toBe('AbortError')
  })

  it('rethrows untouched when the caller already aborted mid-stream-read', async () => {
    const controller = new AbortController()
    controller.abort()
    globalThis.fetch = (async () =>
      sseResponseThatResets([
        { event: 'message_start', data: { message: {} } },
      ])) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    let caught: unknown
    try {
      await provider.run(baseInput({ signal: controller.signal }))
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBeInstanceOf(UpstreamAbortError)
  })
})

// ─── Non-streaming opt-out ──────────────────────────────────────────────────

describe('AnthropicApiProvider.run — stream: false opts back into plain JSON', () => {
  it('sends stream: false and parses the response as a single JSON body', async () => {
    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      return new Response(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'plain json' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const { provider } = makeProvider(configWith({ stream: false }))

    const out = await provider.run(baseInput())

    expect(sentBody.stream).toBe(false)
    expect(out.content).toBe('plain json')
  })
})

// ─── Request shaping (model/effort/mcp/agent-config overrides) ────────────

describe('AnthropicApiProvider.run — request shaping', () => {
  function requestFrom(overrides: Partial<ProviderInput> = {}, settingsOverride = {}) {
    let sentBody: Record<string, unknown> = {}
    let sentHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      sentHeaders = init.headers as Record<string, string>
      return sseResponse(endTurnEvents)
    }) as unknown as typeof fetch
    const { provider } = makeProvider(configWith(settingsOverride))
    return provider.run(baseInput(overrides)).then(() => ({ body: sentBody, headers: sentHeaders }))
  }

  it('applies model/maxTokens/effort overrides from providerConfig', async () => {
    const { body } = await requestFrom({
      providerConfig: { model: 'claude-opus-4-7', effort: 'low', maxTokens: 8000 },
    })
    expect(body.model).toBe('claude-opus-4-7')
    expect(body.max_tokens).toBe(8000)
    expect(body.output_config).toEqual({ effort: 'low' })
  })

  it('drops providerConfig fields foreign to the anthropic-api schema', async () => {
    const { body } = await requestFrom({
      providerConfig: { dangerouslySkipPermissions: true, model: 'ignored' },
    })
    expect(body.model).toBe(DEFAULT_ANTHROPIC_SETTINGS.model)
  })

  it('drops a providerConfig that is not an object', async () => {
    const { body } = await requestFrom({
      providerConfig: 'nope' as unknown as Record<string, unknown>,
    })
    expect(body.model).toBe(DEFAULT_ANTHROPIC_SETTINGS.model)
  })

  it('adds the task-budgets beta header and output_config.task_budget', async () => {
    const { body, headers } = await requestFrom({ providerConfig: { taskBudgetTokens: 50000 } })
    expect(headers['anthropic-beta']).toContain('task-budgets-2026-03-13')
    expect(body.output_config).toEqual({ task_budget: { type: 'tokens', total: 50000 } })
  })

  it('omits output_config when neither effort nor taskBudgetTokens is set', async () => {
    const { body } = await requestFrom()
    expect(body.output_config).toBeUndefined()
  })

  it('forwards http mcp_servers, adds the mcp-client beta header, and adds a matching mcp_toolset', async () => {
    const { body, headers } = await requestFrom(
      {},
      { mcpServers: { docs: { type: 'http', url: 'https://mcp.example/docs' } } },
    )
    expect(body.mcp_servers).toEqual([
      { name: 'docs', type: 'url', url: 'https://mcp.example/docs' },
    ])
    expect(headers['anthropic-beta']).toContain('mcp-client-2025-11-20')
    expect(body.tools).toContainEqual({ type: 'mcp_toolset', mcp_server_name: 'docs' })
  })

  it('extracts a Bearer token from headers.Authorization when authorizationToken is absent', async () => {
    const { body } = await requestFrom(
      {},
      {
        mcpServers: {
          docs: {
            type: 'http',
            url: 'https://mcp.example/docs',
            headers: { Authorization: 'Bearer tok-1' },
          },
        },
      },
    )
    expect(body.mcp_servers).toEqual([
      { name: 'docs', type: 'url', url: 'https://mcp.example/docs', authorization_token: 'tok-1' },
    ])
  })

  it('prefers an explicit authorizationToken over headers.Authorization', async () => {
    const { body } = await requestFrom(
      {},
      {
        mcpServers: {
          docs: {
            type: 'http',
            url: 'https://mcp.example/docs',
            authorizationToken: 'explicit-tok',
            headers: { Authorization: 'Bearer ignored' },
          },
        },
      },
    )
    expect(body.mcp_servers).toEqual([
      {
        name: 'docs',
        type: 'url',
        url: 'https://mcp.example/docs',
        authorization_token: 'explicit-tok',
      },
    ])
  })

  it('drops stdio-only mcp servers (not supported remotely) and omits the beta header', async () => {
    const { body, headers } = await requestFrom(
      {},
      { mcpServers: { local: { type: 'stdio', command: 'node', args: ['server.js'] } } },
    )
    expect(body.mcp_servers).toBeUndefined()
    expect(headers['anthropic-beta']).not.toContain('mcp-client-2025-11-20')
  })

  it('omits mcp_servers entirely when none are configured', async () => {
    const { body } = await requestFrom()
    expect(body.mcp_servers).toBeUndefined()
  })

  it('a per-agent mcpServers override fully replaces the provider default', async () => {
    const { body } = await requestFrom(
      { providerConfig: { mcpServers: { onlyThis: { type: 'sse', url: 'https://x' } } } },
      { mcpServers: { fromDefaults: { type: 'http', url: 'https://mcp.example/other' } } },
    )
    expect(body.mcp_servers).toEqual([{ name: 'onlyThis', type: 'url', url: 'https://x' }])
  })

  it('passes provider-level systemPrompt blocks through verbatim', async () => {
    const { body } = await requestFrom(
      {},
      { systemPrompt: [{ type: 'text', text: 'Static block with {curly} tokens' }] },
    )
    const system = body.system as Array<{ text: string }>
    expect(system.at(-1)?.text).toBe('Static block with {curly} tokens')
  })

  it('prepends per-run systemPromptBlocks ahead of the provider-level ones', async () => {
    const { body } = await requestFrom({
      systemPromptBlocks: [{ type: 'text', text: 'Agent-specific block' }],
    })
    const system = body.system as Array<{ text: string }>
    expect(system[0].text).toBe('Agent-specific block')
  })

  it('omits thinking from the request body when the resolved settings have none', async () => {
    const { body } = await requestFrom({}, { thinking: undefined })
    expect(body.thinking).toBeUndefined()
  })

  it('includes thinking from the resolved settings when present', async () => {
    const { body } = await requestFrom({}, { thinking: { type: 'enabled', budget_tokens: 1024 } })
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
  })

  it('defaults maxTokens to 32000 when neither providerConfig nor settings set it', async () => {
    const { body } = await requestFrom({}, { maxTokens: undefined })
    expect(body.max_tokens).toBe(32000)
  })

  it('clamps a thinkingBudgetTokens that would otherwise exceed max_tokens', async () => {
    const { body } = await requestFrom({
      providerConfig: { thinkingBudgetTokens: 2000, maxTokens: 2500 },
    })
    // 2000 requested, but must stay < max_tokens (2500) — clamped to
    // 2500 - 1024 = 1476, still above the 1024 floor so it's sent as-is.
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1476 })
  })

  it('falls back to the provider default when the clamped budget would drop below the 1024 floor', async () => {
    const { body } = await requestFrom({
      providerConfig: { thinkingBudgetTokens: 5000, maxTokens: 1024 },
    })
    // maxTokens (1024) - 1024 floor = 0 — no room for any thinking budget.
    expect(body.thinking).toEqual(DEFAULT_ANTHROPIC_SETTINGS.thinking)
  })

  it('sends a clamped thinking budget when it fits under max_tokens', async () => {
    const { body } = await requestFrom({
      providerConfig: { thinkingBudgetTokens: 5000, maxTokens: 32000 },
    })
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 })
  })

  it('bumpMaxTokens never lowers max_tokens when resolvedMaxTokens is already >= the cap', async () => {
    const sentBodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBodies.push(JSON.parse(init.body as string))
      return sseResponse(endTurnEvents)
    }) as unknown as typeof fetch
    const port: ToolExecutionPort = {
      getToolDefinitions: () => [],
      executeLoop: async (fetchApi, initialMessages) => {
        await fetchApi(initialMessages)
        await fetchApi(initialMessages, { bumpMaxTokens: true })
        return {
          text: 'ok',
          iters: 2,
          stopReason: 'end_turn',
          truncated: false,
          usage: EMPTY_USAGE,
          toolCalls: 0,
          toolErrors: 0,
        }
      },
    }
    const provider = new AnthropicApiProvider({
      toolExecution: port,
      loadProviderConfig: configWith(),
      log: noopLog,
      skipContextLog: true,
    })
    await provider.run(baseInput({ providerConfig: { maxTokens: 150000 } }))
    expect(sentBodies[0].max_tokens).toBe(150000)
    // Doubling would be 300000, but the 128000 cap alone would have dropped
    // this BELOW the original 150000 — Math.max with the original guards
    // against that regression, so the bumped call must never be lower.
    expect(sentBodies[1].max_tokens).toBe(150000)
  })
})

// ─── Auth header selection ──────────────────────────────────────────────────

describe('AnthropicApiProvider.run — auth', () => {
  it('prefers CLAUDE_CODE_OAUTH_TOKEN over ANTHROPIC_API_KEY when both are set', async () => {
    Bun.env.ANTHROPIC_API_KEY = 'api-key-test'
    let sentHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>
      return sseResponse(endTurnEvents)
    }) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    await provider.run(baseInput())

    expect(sentHeaders.Authorization).toBe('Bearer oauth-test-token')
  })

  it('falls back to ANTHROPIC_API_KEY (x-api-key header) when no OAuth token is set', async () => {
    delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN
    Bun.env.ANTHROPIC_API_KEY = 'api-key-test'
    let sentHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>
      return sseResponse(endTurnEvents)
    }) as unknown as typeof fetch
    const { provider } = makeProvider(configWith())

    await provider.run(baseInput())

    expect(sentHeaders['x-api-key']).toBe('api-key-test')
  })

  it('throws when neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set', async () => {
    delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN
    delete Bun.env.ANTHROPIC_API_KEY
    const { provider } = makeProvider(configWith())

    await expect(provider.run(baseInput())).rejects.toThrow(/No auth configured/)
  })
})

// ─── Context logging ─────────────────────────────────────────────────────────

describe('AnthropicApiProvider.run — context log dump', () => {
  it('writes a context log file when skipContextLog is false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-ctxlog-'))
    try {
      globalThis.fetch = (async () => sseResponse(endTurnEvents)) as unknown as typeof fetch
      const { port } = makeToolExecution()
      const provider = new AnthropicApiProvider({
        toolExecution: port,
        loadProviderConfig: configWith(),
        log: noopLog,
        contextLogDir: dir,
        skipContextLog: false,
      })

      await provider.run(baseInput())

      const { readdirSync } = await import('node:fs')
      const files = readdirSync(dir)
      expect(files.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('logs a warning instead of throwing when the context log directory cannot be created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-flow-ctxlog-'))
    const blockerFile = join(dir, 'blocker')
    writeFileSync(blockerFile, 'not a directory')
    const unwritableDir = join(blockerFile, 'nested')
    try {
      globalThis.fetch = (async () => sseResponse(endTurnEvents)) as unknown as typeof fetch
      const warnings: unknown[] = []
      const { port } = makeToolExecution()
      const provider = new AnthropicApiProvider({
        toolExecution: port,
        loadProviderConfig: configWith(),
        log: { ...noopLog, warn: (obj) => warnings.push(obj) },
        contextLogDir: unwritableDir,
        skipContextLog: false,
      })

      await provider.run(baseInput())

      expect(warnings.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── ProviderInput plumbing (tools/writePaths/policy/runId) ───────────────

describe('AnthropicApiProvider.run — tool context + logging plumbing', () => {
  it('generates a local runId when the orchestrator does not supply one', async () => {
    globalThis.fetch = (async () => sseResponse(endTurnEvents)) as unknown as typeof fetch
    const infoLines: Array<Record<string, unknown>> = []
    const { port } = makeToolExecution()
    const provider = new AnthropicApiProvider({
      toolExecution: port,
      loadProviderConfig: configWith(),
      log: { ...noopLog, info: (obj) => infoLines.push(obj as Record<string, unknown>) },
      skipContextLog: true,
    })

    await provider.run(baseInput())

    const startLine = infoLines.find((l) => l.event === 'agent.start')
    expect(typeof startLine?.runId).toBe('string')
    expect((startLine?.runId as string).length).toBe(8)
  })

  it('logs tool.call and tool.result through the onToolCall/onToolResult callbacks passed to executeLoop', async () => {
    globalThis.fetch = (async () => sseResponse(endTurnEvents)) as unknown as typeof fetch
    const infoLines: Array<Record<string, unknown>> = []
    const port: ToolExecutionPort = {
      getToolDefinitions: () => [],
      executeLoop: async (fetchApi, initialMessages, _ctx, opts) => {
        const response = await fetchApi(initialMessages)
        opts?.onToolCall?.('read_file', { path: 'a.ts' }, 'tu_1')
        opts?.onToolResult?.('read_file', 'x'.repeat(600), 'tu_1')
        return {
          text: 'ok',
          iters: 1,
          stopReason: response.stop_reason,
          truncated: false,
          usage: EMPTY_USAGE,
          toolCalls: 0,
          toolErrors: 0,
        }
      },
    }
    const provider = new AnthropicApiProvider({
      toolExecution: port,
      loadProviderConfig: configWith(),
      log: { ...noopLog, info: (obj) => infoLines.push(obj as Record<string, unknown>) },
      skipContextLog: true,
    })

    await provider.run(baseInput())

    const callLine = infoLines.find((l) => l.event === 'tool.call')
    const resultLine = infoLines.find((l) => l.event === 'tool.result')
    expect(callLine).toMatchObject({
      tool: 'read_file',
      toolUseId: 'tu_1',
      input: { path: 'a.ts' },
    })
    expect((resultLine?.result as string).length).toBe(500)
  })

  it('threads writePaths, taskId, and policy through to ToolContext via executeLoop', async () => {
    globalThis.fetch = (async () => sseResponse(endTurnEvents)) as unknown as typeof fetch
    let seenCtx: unknown
    const port: ToolExecutionPort = {
      getToolDefinitions: () => [],
      executeLoop: async (fetchApi, initialMessages, ctx) => {
        seenCtx = ctx
        const response = await fetchApi(initialMessages)
        return {
          text: 'ok',
          iters: 1,
          stopReason: response.stop_reason,
          truncated: false,
          usage: EMPTY_USAGE,
          toolCalls: 0,
          toolErrors: 0,
        }
      },
    }
    const provider = new AnthropicApiProvider({
      toolExecution: port,
      loadProviderConfig: configWith(),
      log: noopLog,
      skipContextLog: true,
    })

    await provider.run(
      baseInput({
        writePaths: ['/tmp/repo'],
        policy: { toolNames: new Set(['read_file']) },
        repoPaths: { app: '/tmp/repo' },
      }),
    )

    expect(seenCtx).toMatchObject({
      writePaths: ['/tmp/repo'],
      taskId: 'task-1',
      repoPaths: { app: '/tmp/repo' },
    })
  })

  it('rebuilds policy.toolNames into a real Set when it arrives as a plain array (remote agent-host round-trip)', async () => {
    // A remote run (RemoteAgentProvider → apps/agent-host) sends
    // ProviderInput through JSON.stringify/parse, which turns a Set into a
    // plain array on the wire (see RemoteAgentProvider.ts). Regression for
    // "Spread syntax requires ...iterable[Symbol.iterator] to be a
    // function" when downstream code (engine.ts's resolveExecutableTool)
    // calls `.has()` on what it assumes is still a Set.
    globalThis.fetch = (async () => sseResponse(endTurnEvents)) as unknown as typeof fetch
    let seenPolicy: unknown
    let seenToolNames: string[] | undefined
    const port: ToolExecutionPort = {
      getToolDefinitions: (opts) => {
        seenToolNames = opts?.toolNames
        return []
      },
      executeLoop: async (fetchApi, initialMessages, ctx) => {
        seenPolicy = ctx.policy
        const response = await fetchApi(initialMessages)
        return {
          text: 'ok',
          iters: 1,
          stopReason: response.stop_reason,
          truncated: false,
          usage: EMPTY_USAGE,
          toolCalls: 0,
          toolErrors: 0,
        }
      },
    }
    const provider = new AnthropicApiProvider({
      toolExecution: port,
      loadProviderConfig: configWith(),
      log: noopLog,
      skipContextLog: true,
    })

    await provider.run(
      baseInput({
        // Simulates the post-JSON shape — not a Set.
        policy: { toolNames: ['read_file', 'update_issue_body'] as unknown as ReadonlySet<string> },
      }),
    )

    expect(seenToolNames).toEqual(['read_file', 'update_issue_body'])
    expect(seenPolicy).toBeInstanceOf(Object)
    const policy = seenPolicy as { toolNames: Set<string> }
    expect(policy.toolNames).toBeInstanceOf(Set)
    expect(policy.toolNames.has('read_file')).toBe(true)
  })

  it('falls back to an empty allow-list instead of throwing when toolNames is a bare `{}` (an unconverted Set collapsed by JSON)', async () => {
    // Defensive path: a client that skips RemoteAgentProvider's array
    // conversion (an older ia-flow server, or any other caller of
    // POST /v1/run) still sends a Set — which JSON.stringify collapses to
    // `{}`. Assert this degrades to "no tools allowed" instead of crashing
    // the run.
    globalThis.fetch = (async () => sseResponse(endTurnEvents)) as unknown as typeof fetch
    let seenToolNames: string[] | undefined
    let seenPolicy: unknown
    const port: ToolExecutionPort = {
      getToolDefinitions: (opts) => {
        seenToolNames = opts?.toolNames
        return []
      },
      executeLoop: async (fetchApi, initialMessages, ctx) => {
        seenPolicy = ctx.policy
        const response = await fetchApi(initialMessages)
        return {
          text: 'ok',
          iters: 1,
          stopReason: response.stop_reason,
          truncated: false,
          usage: EMPTY_USAGE,
          toolCalls: 0,
          toolErrors: 0,
        }
      },
    }
    const provider = new AnthropicApiProvider({
      toolExecution: port,
      loadProviderConfig: configWith(),
      log: noopLog,
      skipContextLog: true,
    })

    await provider.run(
      baseInput({
        policy: { toolNames: {} as unknown as ReadonlySet<string> },
      }),
    )

    expect(seenToolNames).toEqual([])
    const policy = seenPolicy as { toolNames: Set<string> }
    expect(policy.toolNames).toBeInstanceOf(Set)
    expect(policy.toolNames.size).toBe(0)
  })
})

// ─── MCP tool activity logging (Ejecuciones tab visibility) ───────────────
// `executeLoop`'s own tool_use loop never sees mcp_tool_use/mcp_tool_result
// blocks (Anthropic resolves them server-side), so it never fires
// onToolCall/onToolResult for them. The Ejecuciones tab UI reconstructs
// tool-call cards purely from `tool.call`/`tool.result` log lines keyed by
// `toolUseId` — these tests assert provider.ts emits that same shape for
// MCP tool blocks so they show up there too, without any frontend change.

describe('AnthropicApiProvider.run — MCP tool activity logging', () => {
  function infoEventsFrom(events: SseEvent[]): Promise<Array<Record<string, unknown>>> {
    globalThis.fetch = (async () => sseResponse(events)) as unknown as typeof fetch
    const infoLines: Array<Record<string, unknown>> = []
    const { port } = makeToolExecution()
    const provider = new AnthropicApiProvider({
      toolExecution: port,
      loadProviderConfig: configWith(),
      log: { ...noopLog, info: (obj) => infoLines.push(obj as Record<string, unknown>) },
      skipContextLog: true,
    })
    return provider.run(baseInput()).then(() => infoLines)
  }

  it('logs a tool.call/tool.result pair for a resolved mcp_tool_use block', async () => {
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: {} } },
      {
        event: 'content_block_start',
        data: {
          index: 0,
          content_block: {
            type: 'mcp_tool_use',
            id: 'mcptoolu_1',
            name: 'get_issue',
            server_name: 'github-mcp',
            input: {},
          },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"issue_number":42}' },
        },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      {
        event: 'content_block_start',
        data: {
          index: 1,
          content_block: {
            type: 'mcp_tool_result',
            tool_use_id: 'mcptoolu_1',
            is_error: false,
            content: [{ type: 'text', text: 'issue body' }],
          },
        },
      },
      { event: 'content_block_stop', data: { index: 1 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' } } },
    ]

    const infoLines = await infoEventsFrom(events)

    const call = infoLines.find((l) => l.event === 'tool.call')
    const result = infoLines.find((l) => l.event === 'tool.result')
    expect(call).toMatchObject({
      tool: 'github-mcp:get_issue',
      toolUseId: 'mcptoolu_1',
      input: { issue_number: 42 },
    })
    expect(result).toMatchObject({
      tool: 'github-mcp:get_issue',
      toolUseId: 'mcptoolu_1',
      result: 'issue body',
    })
  })

  it('prefixes the result with [error] when mcp_tool_result.is_error is true', async () => {
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: {} } },
      {
        event: 'content_block_start',
        data: {
          index: 0,
          content_block: {
            type: 'mcp_tool_use',
            id: 'mcptoolu_2',
            name: 'get_issue',
            server_name: 'github-mcp',
            input: {},
          },
        },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      {
        event: 'content_block_start',
        data: {
          index: 1,
          content_block: {
            type: 'mcp_tool_result',
            tool_use_id: 'mcptoolu_2',
            is_error: true,
            content: [{ type: 'text', text: 'not found' }],
          },
        },
      },
      { event: 'content_block_stop', data: { index: 1 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' } } },
    ]

    const infoLines = await infoEventsFrom(events)

    const result = infoLines.find((l) => l.event === 'tool.result')
    expect(result?.result).toBe('[error] not found')
  })

  it('logs only tool.call (no tool.result) when the mcp_tool_use has no matching result yet', async () => {
    const events: SseEvent[] = [
      { event: 'message_start', data: { message: {} } },
      {
        event: 'content_block_start',
        data: {
          index: 0,
          content_block: {
            type: 'mcp_tool_use',
            id: 'mcptoolu_3',
            name: 'get_issue',
            server_name: 'github-mcp',
            input: {},
          },
        },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' } } },
    ]

    const infoLines = await infoEventsFrom(events)

    expect(infoLines.some((l) => l.event === 'tool.call')).toBe(true)
    expect(infoLines.some((l) => l.event === 'tool.result')).toBe(false)
  })

  it('emits no tool.call/tool.result lines when the response has no MCP tool blocks', async () => {
    const infoLines = await infoEventsFrom(endTurnEvents)

    expect(infoLines.some((l) => l.event === 'tool.call' || l.event === 'tool.result')).toBe(false)
  })
})
