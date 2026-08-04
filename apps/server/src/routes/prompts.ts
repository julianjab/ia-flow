import { Hono } from 'hono'
import { StepTypeSchema, type StepType } from '@ia-flow/shared'
import { loadProviderConfig, saveProviderConfig } from '../providers/index.js'
import { DEFAULT_PHASE_PROMPTS } from '../prompts/defaults.js'
import { PHASE_VARIABLES } from '../prompts/variables.js'

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

  return router
}
