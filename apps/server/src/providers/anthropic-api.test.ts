import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { promptRepo } from '../composition/container.js'
import { anthropicApiProvider, interpolate } from './anthropic-api.js'
import { DEFAULT_ANTHROPIC_SETTINGS, loadProviderConfig, saveProviderConfig } from './index.js'
import type { StepInput } from './index.js'

const originalFetch = globalThis.fetch
let originalDbConfig: Record<string, unknown> | null = null

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  originalDbConfig = promptRepo.getProviderConfigBlob()
})

afterAll(() => {
  if (originalDbConfig !== null) promptRepo.setProviderConfigBlob(originalDbConfig)
  else promptRepo.deleteProviderConfigBlob()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(): { calls: any[] } {
  const calls: any[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string))
    return new Response(
      JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return { calls }
}

async function runWithSystemPrompt(
  systemPrompt: Array<{ type: 'text'; text: string }>,
  overrides: Partial<StepInput> = {},
  settingsOverride: Partial<typeof DEFAULT_ANTHROPIC_SETTINGS> = {},
) {
  const cfg = await loadProviderConfig()
  await saveProviderConfig({
    ...cfg,
    steps: { ...cfg.steps, 'refine-functional': 'anthropic-api' },
    anthropicApi: { ...DEFAULT_ANTHROPIC_SETTINGS, ...settingsOverride, systemPrompt },
  })
  const { calls } = stubFetch()
  const input: StepInput = {
    step: 'refine-functional',
    taskTitle: 'Add login',
    taskDescription: 'desc',
    taskType: 'feat',
    repos: ['ims-web', 'ims-backend'],
    contexts: [],
    prompt: 'hello',
    ...overrides,
  }
  await anthropicApiProvider.run(input)
  return calls[0]
}

describe('interpolate', () => {
  it('replaces known placeholders and preserves unknown', () => {
    expect(interpolate('a {x} b {y}', { x: '1' })).toBe('a 1 b {y}')
  })
})

async function runOnce(
  overrides: Partial<StepInput> = {},
  settingsOverride: Partial<typeof DEFAULT_ANTHROPIC_SETTINGS> = {},
) {
  const cfg = await loadProviderConfig()
  await saveProviderConfig({
    ...cfg,
    steps: { ...cfg.steps, 'refine-functional': 'anthropic-api' },
    anthropicApi: { ...DEFAULT_ANTHROPIC_SETTINGS, ...settingsOverride },
  })
  const stub = { calls: [] as any[], headers: [] as Record<string, string>[] }
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    stub.calls.push(JSON.parse(init.body as string))
    stub.headers.push(init.headers as Record<string, string>)
    return new Response(
      JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  const input: StepInput = {
    step: 'refine-functional',
    taskTitle: 't',
    taskDescription: 'd',
    taskType: 'feat',
    repos: [],
    contexts: [],
    prompt: 'hi',
    ...overrides,
  }
  await anthropicApiProvider.run(input)
  return stub
}

describe('anthropicApiProvider.run — per-agent providerConfig', () => {
  it('applies model, maxTokens, and effort overrides from providerConfig', async () => {
    const { calls } = await runOnce({
      providerConfig: {
        model: 'claude-opus-4-7',
        effort: 'low',
        maxTokens: 8000,
      },
    })
    expect(calls[0].model).toBe('claude-opus-4-7')
    expect(calls[0].max_tokens).toBe(8000)
    expect(calls[0].output_config).toEqual({ effort: 'low' })
  })

  it('adds task-budgets beta header and output_config.task_budget when taskBudgetTokens set', async () => {
    const { calls, headers } = await runOnce({
      providerConfig: { taskBudgetTokens: 50000 },
    })
    expect(headers[0]['anthropic-beta']).toContain('task-budgets-2026-03-13')
    expect(calls[0].output_config.task_budget).toEqual({ type: 'tokens', total: 50000 })
  })

  it('omits output_config entirely when neither effort nor taskBudgetTokens are set', async () => {
    const { calls } = await runOnce()
    expect(calls[0].output_config).toBeUndefined()
  })

  it('behaves identically to baseline when no providerConfig is provided', async () => {
    const { calls, headers } = await runOnce()
    expect(calls[0].model).toBe(DEFAULT_ANTHROPIC_SETTINGS.model)
    expect(calls[0].max_tokens).toBe(32000)
    expect(calls[0].output_config).toBeUndefined()
    expect(headers[0]['anthropic-beta']).not.toContain('task-budgets-2026-03-13')
  })

  it('forwards mcp_servers (http) to Anthropic API body and adds beta header', async () => {
    const { calls, headers } = await runOnce(
      {},
      {
        mcpServers: {
          docs: { type: 'http', url: 'https://mcp.example/docs' },
        },
      },
    )
    expect(calls[0].mcp_servers).toEqual([
      { name: 'docs', type: 'url', url: 'https://mcp.example/docs' },
    ])
    expect(headers[0]['anthropic-beta']).toContain('mcp-client-2025-04-04')
  })

  it('omits mcp_servers when only stdio entries are configured', async () => {
    const { calls, headers } = await runOnce(
      {},
      {
        mcpServers: {
          local: { type: 'stdio', command: 'node', args: ['server.js'] },
        },
      },
    )
    expect(calls[0].mcp_servers).toBeUndefined()
    expect(headers[0]['anthropic-beta']).not.toContain('mcp-client-2025-04-04')
  })

  it('omits mcp_servers when none are configured', async () => {
    const { calls } = await runOnce()
    expect(calls[0].mcp_servers).toBeUndefined()
  })

  it('per-agent mcpServers override replaces provider defaults', async () => {
    const { calls } = await runOnce(
      {
        providerConfig: {
          mcpServers: {
            onlyThis: { type: 'sse', url: 'https://x' },
          },
        },
      },
      {
        mcpServers: {
          fromDefaults: { type: 'http', url: 'https://mcp.example/other' },
        },
      },
    )
    expect(calls[0].mcp_servers).toEqual([{ name: 'onlyThis', type: 'url', url: 'https://x' }])
  })

  it('ignores providerConfig with fields foreign to the anthropic-api schema', async () => {
    // Under the open providerConfig shape, per-provider strictness lives in
    // each provider file. anthropic-api's schema is strict and unknown keys
    // (like `dangerouslySkipPermissions`) make parsing fail; overrides are
    // silently dropped and defaults win.
    const { calls } = await runOnce({
      providerConfig: { dangerouslySkipPermissions: true, model: 'ignored' },
    })
    expect(calls[0].model).toBe(DEFAULT_ANTHROPIC_SETTINGS.model)
  })
})

describe('anthropicApiProvider.run — systemPrompt interpolation', () => {
  it('interpolates task_title and repos', async () => {
    const body = await runWithSystemPrompt([
      { type: 'text', text: 'Task: {task_title} on {repos}' },
    ])
    expect(body.system[0].text).toBe('Task: Add login on ims-web, ims-backend')
  })

  it('response_language uses value from settings', async () => {
    const body = await runWithSystemPrompt(
      [{ type: 'text', text: 'Reply in {response_language}' }],
      {},
      { responseLanguage: 'español' },
    )
    expect(body.system[0].text).toBe('Reply in español')
  })

  it('preserves unknown placeholders literally', async () => {
    const body = await runWithSystemPrompt([{ type: 'text', text: 'keep {unknown_var} as is' }])
    expect(body.system[0].text).toBe('keep {unknown_var} as is')
  })
})
