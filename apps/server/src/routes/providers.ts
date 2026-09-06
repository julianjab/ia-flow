import { type RepoMapping, type StepType, validateAnthropicApiSettings } from '@ia-flow/shared'
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

  // PUT /api/providers/config — update provider config (steps and/or anthropicApi settings).
  // Merge convention: for object fields (anthropicApi, tmuxClaude, itermClaude),
  //   · key absent from body → keep current value
  //   · key present with `null`   → delete (unset) that key
  //   · key present with a value  → overwrite
  // This lets the UI clear a field (e.g. taskBudgetTokens) by sending `null`,
  // which the previous naive spread couldn't express.
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
      const mergeWithNullDelete = <T extends object>(
        base: T | undefined,
        patch: Record<string, unknown> | undefined,
      ): T => {
        const merged: Record<string, unknown> = { ...(base ?? {}) }
        if (patch) {
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete merged[key]
            else merged[key] = value
          }
        }
        return merged as T
      }
      const updated = {
        ...current,
        steps: { ...current.steps, ...(body.steps ?? {}) },
        anthropicApi: mergeWithNullDelete(
          current.anthropicApi,
          body.anthropicApi as Record<string, unknown> | undefined,
        ),
        tmuxClaude:
          body.tmuxClaude !== undefined
            ? mergeWithNullDelete(current.tmuxClaude, body.tmuxClaude as Record<string, unknown>)
            : current.tmuxClaude,
        itermClaude:
          body.itermClaude !== undefined
            ? mergeWithNullDelete(current.itermClaude, body.itermClaude as Record<string, unknown>)
            : current.itermClaude,
        repoMappings:
          body.repoMappings && Object.keys(body.repoMappings).length > 0
            ? body.repoMappings
            : current.repoMappings,
      }
      const effortError = validateAnthropicApiSettings(updated.anthropicApi)
      if (effortError) return c.json({ error: effortError }, 400)
      await saveProviderConfig(updated)
      return c.json({ config: updated })
    } catch (err) {
      return c.json({ error: 'Invalid config body' }, 400)
    }
  })

  return router
}
