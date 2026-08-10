import { ProjectSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  archiveDbProject,
  getDbProject,
  listAgentsForRuntime,
  listDbProjects,
  listSystemPromptsForRuntime,
  upsertDbProject,
} from '../db.js'
import { invalidateSourceForProject } from '../project-sources/registry.js'

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

  // Overlay view for the UI: globals + this project's own rows. Project rows
  // shadow globals when ids collide (same rule the daemon uses at runtime).
  // Kept as a read-only endpoint — writes still go through /api/project-config
  // scoped to this project, so nobody accidentally edits a global from here.
  router.get('/:id/available-agents', (c) => {
    const id = c.req.param('id')
    if (!getDbProject(id)) return c.json({ error: 'Project not found', agents: [] }, 404)
    return c.json({ agents: listAgentsForRuntime(id) })
  })

  router.get('/:id/available-system-prompts', (c) => {
    const id = c.req.param('id')
    if (!getDbProject(id)) return c.json({ error: 'Project not found', systemPrompts: [] }, 404)
    return c.json({ systemPrompts: listSystemPromptsForRuntime(id) })
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
      // Invalidate cached source for the OLD config before the write, so any
      // in-flight reads settle against the fresh URL on the next request.
      invalidateSourceForProject(existing)
      const project = upsertDbProject(merged)
      return c.json({ project })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.delete('/:id', (c) => {
    const id = c.req.param('id')
    const existing = getDbProject(id)
    if (!existing) return c.json({ error: 'Project not found' }, 404)
    invalidateSourceForProject(existing)
    archiveDbProject(id)
    return c.json({ ok: true })
  })

  return router
}
