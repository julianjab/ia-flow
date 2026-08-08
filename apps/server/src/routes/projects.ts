import { ProjectSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { archiveDbProject, getDbProject, listDbProjects, upsertDbProject } from '../db.js'

// Input schema for POST/PATCH — clients don't set timestamps.
const ProjectInputSchema = ProjectSchema.pick({
  id: true,
  name: true,
  githubProjectUrl: true,
  settings: true,
})

const ProjectPatchSchema = z.object({
  name: z.string().optional(),
  githubProjectUrl: z.string().nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

export function createProjectsRouter() {
  const router = new Hono()

  router.get('/', (c) => {
    const includeArchived = c.req.query('includeArchived') === 'true'
    return c.json({ projects: listDbProjects(includeArchived) })
  })

  router.get('/:id', (c) => {
    const project = getDbProject(c.req.param('id'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    return c.json({ project })
  })

  router.post('/', async (c) => {
    try {
      const body = await c.req.json()
      const validated = ProjectInputSchema.parse(body)
      if (getDbProject(validated.id)) {
        return c.json({ error: `Project ${validated.id} already exists` }, 409)
      }
      const project = upsertDbProject(validated)
      return c.json({ project }, 201)
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.patch('/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const existing = getDbProject(id)
      if (!existing) return c.json({ error: 'Project not found' }, 404)
      const patch = ProjectPatchSchema.parse(await c.req.json())
      const merged = {
        id,
        name: patch.name ?? existing.name,
        githubProjectUrl:
          patch.githubProjectUrl === undefined ? existing.githubProjectUrl : patch.githubProjectUrl,
        settings: patch.settings ?? existing.settings,
      }
      const project = upsertDbProject(merged)
      return c.json({ project })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.delete('/:id', (c) => {
    const id = c.req.param('id')
    if (!getDbProject(id)) return c.json({ error: 'Project not found' }, 404)
    archiveDbProject(id)
    return c.json({ ok: true })
  })

  return router
}
