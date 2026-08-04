import { Hono } from 'hono'
import {
  listProviders,
  loadProviderConfig,
  saveProviderConfig,
  type StepType,
} from '../providers/index.js'
import type { RepoMapping } from '@ia-flow/shared'

export function createProvidersRouter() {
  const router = new Hono()

  // GET /api/providers — list registered providers + current config
  router.get('/', async (c) => {
    const providers = listProviders().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
    }))
    const config = await loadProviderConfig()
    return c.json({ providers, config })
  })

  // PUT /api/providers/config — update provider config (steps and/or anthropicApi settings)
  router.put('/config', async (c) => {
    try {
      const body = await c.req.json<{
        steps?: Partial<Record<StepType, string>>
        anthropicApi?: object
        repoMappings?: RepoMapping
        phasePrompts?: Record<string, string>
      }>()
      const current = await loadProviderConfig()
      const updated = {
        ...current,
        steps: { ...current.steps, ...(body.steps ?? {}) },
        anthropicApi: { ...current.anthropicApi, ...(body.anthropicApi ?? {}) },
        repoMappings: body.repoMappings ?? current.repoMappings,
        phasePrompts: body.phasePrompts ?? current.phasePrompts,
      }
      await saveProviderConfig(updated)
      return c.json({ config: updated })
    } catch (err) {
      return c.json({ error: 'Invalid config body' }, 400)
    }
  })

  return router
}
