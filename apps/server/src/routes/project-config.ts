import { ProjectConfigSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { getProjectConfigFromDb, saveProjectConfigToDb } from '../db.js'

export function createProjectConfigRouter() {
  const router = new Hono()

  router.get('/', (c) => {
    const config = getProjectConfigFromDb()
    const raw = stringifyYaml(config, { lineWidth: 0 })
    return c.json({ config, raw })
  })

  router.put('/', async (c) => {
    try {
      const body = await c.req.json<{ config: unknown }>()
      const validated = ProjectConfigSchema.parse(body.config)
      saveProjectConfigToDb(validated)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  // Accepts raw YAML — useful for bulk import / paste from editor
  router.put('/raw', async (c) => {
    try {
      const body = await c.req.json<{ raw: string }>()
      const parsed = parseYaml(body.raw)
      const validated = ProjectConfigSchema.parse(parsed)
      saveProjectConfigToDb(validated)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  return router
}
