import { Hono } from 'hono'
import { StepTypeSchema, type StepType } from '@ia-flow/shared'
import { loadProviderConfig, saveProviderConfig } from '../providers/index.js'
import { DEFAULT_PHASE_PROMPTS, DEFAULT_FILE_SIMPLIFIER_PROMPT, DEFAULT_COMPACTION_PROMPT } from '../prompts/defaults.js'
import { PHASE_VARIABLES } from '../prompts/variables.js'

type UtilityKey = 'file-simplifier' | 'compaction'
const UTILITY_KEYS: UtilityKey[] = ['file-simplifier', 'compaction']
const UTILITY_CONFIG_KEY: Record<UtilityKey, 'fileSimplifierPrompt' | 'compactionPrompt'> = {
  'file-simplifier': 'fileSimplifierPrompt',
  'compaction': 'compactionPrompt',
}
const UTILITY_DEFAULTS: Record<UtilityKey, string> = {
  'file-simplifier': DEFAULT_FILE_SIMPLIFIER_PROMPT,
  'compaction': DEFAULT_COMPACTION_PROMPT,
}

function buildPhase(step: StepType, override: string | undefined) {
  const defaultPrompt = DEFAULT_PHASE_PROMPTS[step]
  const isCustomized = typeof override === 'string' && override !== defaultPrompt
  return {
    step,
    prompt: isCustomized ? override! : defaultPrompt,
    defaultPrompt,
    isCustomized,
    variables: PHASE_VARIABLES[step],
  }
}

export function createPromptsRouter() {
  const router = new Hono()

  router.get('/', async (c) => {
    const config = await loadProviderConfig()
    const overrides = config.phasePrompts ?? {}
    const steps = StepTypeSchema.options
    const prompts = steps.map((s) => buildPhase(s, overrides[s]))
    return c.json({ prompts })
  })

  router.put('/:step', async (c) => {
    const parsed = StepTypeSchema.safeParse(c.req.param('step'))
    if (!parsed.success) return c.json({ error: 'Unknown step' }, 400)
    const step = parsed.data

    let body: { prompt?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (typeof body?.prompt !== 'string') {
      return c.json({ error: 'Body must include a string "prompt" field' }, 400)
    }

    const current = await loadProviderConfig()
    const updated = {
      ...current,
      phasePrompts: { ...(current.phasePrompts ?? {}), [step]: body.prompt },
    }
    await saveProviderConfig(updated)
    return c.json(buildPhase(step, body.prompt))
  })

  router.delete('/:step', async (c) => {
    const parsed = StepTypeSchema.safeParse(c.req.param('step'))
    if (!parsed.success) return c.json({ error: 'Unknown step' }, 400)
    const step = parsed.data

    const current = await loadProviderConfig()
    const { [step]: _removed, ...rest } = current.phasePrompts ?? {}
    const updated = { ...current, phasePrompts: rest }
    await saveProviderConfig(updated)
    return c.json(buildPhase(step, undefined))
  })

  // ─── Utility prompts (file-simplifier, compaction) ──────────────────────

  router.get('/utility', async (c) => {
    const config = await loadProviderConfig()
    const result: Record<string, object> = {}
    for (const key of UTILITY_KEYS) {
      const cfgKey = UTILITY_CONFIG_KEY[key]
      const def = UTILITY_DEFAULTS[key]
      const saved = config[cfgKey]
      result[key] = { prompt: saved ?? def, defaultPrompt: def, isCustomized: !!saved && saved !== def }
    }
    return c.json(result)
  })

  router.put('/utility/:key', async (c) => {
    const key = c.req.param('key') as UtilityKey
    if (!UTILITY_KEYS.includes(key)) return c.json({ error: 'Unknown utility prompt key' }, 400)
    let body: { prompt?: unknown }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    if (typeof body?.prompt !== 'string') return c.json({ error: 'prompt must be a string' }, 400)
    const current = await loadProviderConfig()
    await saveProviderConfig({ ...current, [UTILITY_CONFIG_KEY[key]]: body.prompt })
    return c.json({ ok: true })
  })

  router.delete('/utility/:key', async (c) => {
    const key = c.req.param('key') as UtilityKey
    if (!UTILITY_KEYS.includes(key)) return c.json({ error: 'Unknown utility prompt key' }, 400)
    const current = await loadProviderConfig()
    const { [UTILITY_CONFIG_KEY[key]]: _removed, ...rest } = current as any
    await saveProviderConfig(rest)
    return c.json({ ok: true })
  })

  return router
}
