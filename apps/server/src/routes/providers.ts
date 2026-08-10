import type { RepoMapping, StepType } from '@ia-flow/shared'
import { Hono } from 'hono'
import { loadProviderConfig, saveProviderConfig } from '../application/provider-config.js'
import { providerRegistry } from '../composition/container.js'

export function createProvidersRouter() {
  const router = new Hono()

  // GET /api/providers — list registered providers + current config
  router.get('/', async (c) => {
    const providers = providerRegistry.list().map((p) => ({
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
        tmuxClaude?: object
        itermClaude?: object
        repoMappings?: RepoMapping
      }>()
      const current = await loadProviderConfig()
      const updated = {
        ...current,
        steps: { ...current.steps, ...(body.steps ?? {}) },
        anthropicApi: { ...current.anthropicApi, ...(body.anthropicApi ?? {}) },
        tmuxClaude:
          body.tmuxClaude !== undefined
            ? { ...current.tmuxClaude, ...body.tmuxClaude }
            : current.tmuxClaude,
        itermClaude:
          body.itermClaude !== undefined
            ? { ...current.itermClaude, ...body.itermClaude }
            : current.itermClaude,
        repoMappings:
          body.repoMappings && Object.keys(body.repoMappings).length > 0
            ? body.repoMappings
            : current.repoMappings,
      }
      await saveProviderConfig(updated)
      return c.json({ config: updated })
    } catch (err) {
      return c.json({ error: 'Invalid config body' }, 400)
    }
  })

  return router
}
