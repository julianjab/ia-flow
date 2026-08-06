import { describe, expect, it, beforeAll, afterAll, afterEach } from 'bun:test'
import { anthropicApiProvider, interpolate } from './anthropic-api.js'
import { saveProviderConfig, loadProviderConfig, DEFAULT_ANTHROPIC_SETTINGS } from './index.js'
import { getProviderConfigFromDb, setProviderConfigToDb, deleteProviderConfigFromDb } from '../db.js'
import type { StepInput } from './index.js'

const originalFetch = globalThis.fetch
let originalDbConfig: Record<string, unknown> | null = null

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  originalDbConfig = getProviderConfigFromDb()
})

afterAll(() => {
  if (originalDbConfig !== null) setProviderConfigToDb(originalDbConfig)
  else deleteProviderConfigFromDb()
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

async function runOnce(overrides: Partial<StepInput> = {}, settingsOverride: Partial<typeof DEFAULT_ANTHROPIC_SETTINGS> = {}) {
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
      providerConfig: { provider: 'anthropic-api', model: 'claude-opus-4-7', effort: 'low', maxTokens: 8000 },
    })
    expect(calls[0].model).toBe('claude-opus-4-7')
    expect(calls[0].max_tokens).toBe(8000)
    expect(calls[0].output_config).toEqual({ effort: 'low' })
  })

  it('adds task-budgets beta header and output_config.task_budget when taskBudgetTokens set', async () => {
    const { calls, headers } = await runOnce({
      providerConfig: { provider: 'anthropic-api', taskBudgetTokens: 50000 },
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

  it('does not confuse a terminal-variant providerConfig with anthropic-api overrides', async () => {
    const { calls } = await runOnce({
      // Wrong-variant discriminator; anthropic-api should ignore and fall back to cfg.
      providerConfig: { provider: 'tmux-claude', model: 'ignored' } as any,
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
    const body = await runWithSystemPrompt([
      { type: 'text', text: 'keep {unknown_var} as is' },
    ])
    expect(body.system[0].text).toBe('keep {unknown_var} as is')
  })
})
