import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createPromptsRouter } from './prompts.js'
import { saveProviderConfig, loadProviderConfig, DEFAULT_ANTHROPIC_SETTINGS } from '../providers/index.js'
import { DEFAULT_PHASE_PROMPTS } from '../prompts/defaults.js'
import { PHASE_VARIABLES } from '../prompts/variables.js'
import type { ProviderConfig } from '@ia-flow/shared'

const CONFIG_PATH = join(import.meta.dir, '..', '..', 'config', 'providers.json')
let originalConfig: string | null = null

function baseConfig(phasePrompts: Record<string, string> = {}): ProviderConfig {
  return {
    steps: {
      'refine-functional': 'anthropic-api',
      'refine-technical': 'anthropic-api',
      implement: 'tmux-claude',
    },
    anthropicApi: DEFAULT_ANTHROPIC_SETTINGS,
    repoMappings: {},
    phasePrompts,
  }
}

const app = createPromptsRouter()
const call = (path: string, init?: RequestInit) =>
  app.request(new Request(`http://test${path}`, init))

beforeAll(async () => {
  if (existsSync(CONFIG_PATH)) originalConfig = await readFile(CONFIG_PATH, 'utf-8')
})

afterAll(async () => {
  if (originalConfig !== null) await writeFile(CONFIG_PATH, originalConfig, 'utf-8')
  else if (existsSync(CONFIG_PATH)) await unlink(CONFIG_PATH)
})

beforeEach(async () => {
  if (existsSync(CONFIG_PATH)) await unlink(CONFIG_PATH)
})

describe('GET /api/prompts', () => {
  it('returns all three phases with defaults when no overrides', async () => {
    await saveProviderConfig(baseConfig({}))
    const res = await call('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { prompts: Array<Record<string, unknown>> }
    expect(body.prompts).toHaveLength(3)
    const steps = body.prompts.map((p) => p.step)
    expect(steps).toEqual(['refine-functional', 'refine-technical', 'implement'])
    for (const p of body.prompts) {
      const step = p.step as keyof typeof DEFAULT_PHASE_PROMPTS
      expect(p.isCustomized).toBe(false)
      expect(p.prompt).toBe(DEFAULT_PHASE_PROMPTS[step])
      expect(p.defaultPrompt).toBe(DEFAULT_PHASE_PROMPTS[step])
      expect(p.variables).toEqual(PHASE_VARIABLES[step])
    }
  })
})

describe('PUT /api/prompts/:step', () => {
  it('saves an override for a phase', async () => {
    await saveProviderConfig(baseConfig({}))
    const res = await call('/refine-technical', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'New template' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      step: 'refine-technical',
      prompt: 'New template',
      defaultPrompt: DEFAULT_PHASE_PROMPTS['refine-technical'],
      isCustomized: true,
      variables: PHASE_VARIABLES['refine-technical'],
    })
    const reloaded = await loadProviderConfig()
    expect(reloaded.phasePrompts?.['refine-technical']).toBe('New template')
    expect(reloaded.steps).toEqual(baseConfig().steps)
    expect(reloaded.anthropicApi).toEqual(DEFAULT_ANTHROPIC_SETTINGS)
  })

  it('rejects unknown step with 400 and leaves disk unchanged', async () => {
    await saveProviderConfig(baseConfig({}))
    const before = await readFile(CONFIG_PATH, 'utf-8')
    const res = await call('/unknown-step', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    })
    expect(res.status).toBe(400)
    const after = await readFile(CONFIG_PATH, 'utf-8')
    expect(after).toBe(before)
  })

  it('rejects invalid body (missing prompt) with 400 and leaves disk unchanged', async () => {
    await saveProviderConfig(baseConfig({}))
    const before = await readFile(CONFIG_PATH, 'utf-8')
    const res = await call('/refine-functional', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const after = await readFile(CONFIG_PATH, 'utf-8')
    expect(after).toBe(before)
  })
})

describe('DELETE /api/prompts/:step', () => {
  it('restores default and removes the override key from disk', async () => {
    await saveProviderConfig(baseConfig({ implement: 'custom' }))
    const res = await call('/implement', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.step).toBe('implement')
    expect(body.isCustomized).toBe(false)
    expect(body.prompt).toBe(DEFAULT_PHASE_PROMPTS['implement'])
    const reloaded = await loadProviderConfig()
    expect(reloaded.phasePrompts?.['implement']).toBeUndefined()
  })
})
