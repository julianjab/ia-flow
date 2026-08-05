import { Hono } from 'hono'
import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { ProjectConfigSchema } from '@ia-flow/shared'
import { invalidateProjectConfig } from '../config/project-config.js'

const CONFIG_PATH = join(import.meta.dir, '..', '..', 'config', 'project-config.yaml')

export function createProjectConfigRouter() {
  const router = new Hono()

  router.get('/', async (c) => {
    if (!existsSync(CONFIG_PATH)) return c.json({ config: null, raw: '' })
    const raw = await readFile(CONFIG_PATH, 'utf-8')
    try {
      const config = parseYaml(raw)
      return c.json({ config, raw })
    } catch {
      return c.json({ config: null, raw })
    }
  })

  router.put('/', async (c) => {
    const body = await c.req.json<{ config: unknown }>()
    const validated = ProjectConfigSchema.parse(body.config)
    await writeFile(CONFIG_PATH, stringifyYaml(validated, { lineWidth: 0 }), 'utf-8')
    invalidateProjectConfig()
    return c.json({ ok: true })
  })

  router.put('/raw', async (c) => {
    const body = await c.req.json<{ raw: string }>()
    const parsed = parseYaml(body.raw)
    ProjectConfigSchema.parse(parsed) // validate before saving
    await writeFile(CONFIG_PATH, body.raw, 'utf-8')
    invalidateProjectConfig()
    return c.json({ ok: true })
  })

  return router
}
