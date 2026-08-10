import { ProjectConfigSchema } from '@ia-flow/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { configRepo } from '../composition/container.js'

// Resolves the target scope for the current request. Precedence:
//   ?scope=global (or body.scope === 'global') → null (globals only)
//   ?projectId=X  (or body.projectId)          → that project's own rows
//   nothing                                    → default project (back-compat)
function resolveScope(
  c: Context,
  body?: { projectId?: string; scope?: string },
): string | null | undefined {
  const scope = c.req.query('scope') ?? body?.scope
  if (scope === 'global') return null
  return c.req.query('projectId') ?? body?.projectId ?? undefined
}

export function createProjectConfigRouter() {
  const router = new Hono()

  router.get('/', async (c) => {
    const config = await configRepo.getConfig(resolveScope(c))
    const raw = stringifyYaml(config, { lineWidth: 0 })
    return c.json({ config, raw })
  })

  router.put('/', async (c) => {
    try {
      const body = await c.req.json<{ config: unknown; projectId?: string; scope?: string }>()
      const validated = ProjectConfigSchema.parse(body.config)
      await configRepo.saveConfig(validated, resolveScope(c, body))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  // Accepts raw YAML — useful for bulk import / paste from editor
  router.put('/raw', async (c) => {
    try {
      const body = await c.req.json<{ raw: string; projectId?: string; scope?: string }>()
      const parsed = parseYaml(body.raw)
      const validated = ProjectConfigSchema.parse(parsed)
      await configRepo.saveConfig(validated, resolveScope(c, body))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  return router
}
