import type { Context } from 'hono'
import { Hono } from 'hono'
import { stringify as stringifyYaml } from 'yaml'
import { configRepo } from '../composition/container.js'

// Read-only aggregate view over per-domain repos. Writes go through the
// granular endpoints:
//   agents         → /api/agents-crud
//   system prompts → /api/system-prompts
//   statuses       → /api/statuses
//   project fields → PATCH /api/projects/:id
function resolveScope(c: Context): string | null | undefined {
  const scope = c.req.query('scope')
  if (scope === 'global') return null
  return c.req.query('projectId') ?? undefined
}

export function createProjectConfigRouter() {
  const router = new Hono()

  router.get('/', async (c) => {
    const config = await configRepo.getConfig(resolveScope(c))
    const raw = stringifyYaml(config, { lineWidth: 0 })
    return c.json({ config, raw })
  })

  return router
}
