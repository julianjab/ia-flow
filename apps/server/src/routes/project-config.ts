import { ProjectConfigSchema } from '@ia-flow/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { getProjectConfigFromDb, saveProjectConfigToDb } from '../db.js'

// Reads ?projectId= from either query string or JSON body. Falls back to the
// default project (first non-archived) if omitted — keeps single-project clients
// working during rollout.
function resolveProjectId(c: Context, body?: { projectId?: string }): string | undefined {
  return c.req.query('projectId') ?? body?.projectId ?? undefined
}

export function createProjectConfigRouter() {
  const router = new Hono()

  router.get('/', (c) => {
    const projectId = resolveProjectId(c)
    const config = getProjectConfigFromDb(projectId)
    const raw = stringifyYaml(config, { lineWidth: 0 })
    return c.json({ config, raw })
  })

  router.put('/', async (c) => {
    try {
      const body = await c.req.json<{ config: unknown; projectId?: string }>()
      const validated = ProjectConfigSchema.parse(body.config)
      saveProjectConfigToDb(validated, resolveProjectId(c, body))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  // Accepts raw YAML — useful for bulk import / paste from editor
  router.put('/raw', async (c) => {
    try {
      const body = await c.req.json<{ raw: string; projectId?: string }>()
      const parsed = parseYaml(body.raw)
      const validated = ProjectConfigSchema.parse(parsed)
      saveProjectConfigToDb(validated, resolveProjectId(c, body))
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  return router
}
