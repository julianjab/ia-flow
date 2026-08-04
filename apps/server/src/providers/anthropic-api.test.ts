import { describe, expect, it, beforeAll, afterAll, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { anthropicApiProvider, interpolate } from './anthropic-api.js'
import { saveProviderConfig, loadProviderConfig, DEFAULT_ANTHROPIC_SETTINGS } from './index.js'
import type { StepInput } from './index.js'

const originalFetch = globalThis.fetch
const CONFIG_PATH = join(import.meta.dir, '..', '..', 'config', 'providers.json')
let originalConfig: string | null = null

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  if (existsSync(CONFIG_PATH)) originalConfig = await readFile(CONFIG_PATH, 'utf-8')
})

afterAll(async () => {
  if (originalConfig !== null) await writeFile(CONFIG_PATH, originalConfig, 'utf-8')
  else if (existsSync(CONFIG_PATH)) await unlink(CONFIG_PATH)
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
