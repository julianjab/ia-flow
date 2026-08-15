import {
  isProjectPaused,
  listPausedProjects,
  pauseProject,
  resumeProject,
} from '@ia-flow/issue-sources'
import { ProjectSchema, SourceRefSchema, invalidateMemoized } from '@ia-flow/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  agentRepo,
  broadcast,
  configRepo,
  projectRepo,
  sourceFactory,
} from '../composition/container.js'
import { reloadManagers } from '../daemon.js'
import type { ISystemPromptRepository } from '../domain/ports/ISystemPromptRepository.js'
import { getDb } from '../infrastructure/db/database.js'

// See the matching comment in agents-crud.ts — configRepo.getConfig is
// memoized and shared with GET /api/project-config.
function invalidateConfigCache(): void {
  invalidateMemoized(configRepo, 'getConfig')
}

// Input schema for POST/PATCH — clients don't set timestamps.
const ProjectInputSchema = ProjectSchema.pick({
  id: true,
  name: true,
  source: true,
  settings: true,
})

const ProjectPatchSchema = z.object({
  name: z.string().optional(),
  language: z.string().optional(),
  source: SourceRefSchema.nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

export function createProjectsRouter(systemPromptRepo: ISystemPromptRepository) {
  const router = new Hono()

  router.get('/', (c) => {
    const includeArchived = c.req.query('includeArchived') === 'true'
    return c.json({ projects: projectRepo.list(includeArchived) })
  })

  router.get('/:id', (c) => {
    const project = projectRepo.get(c.req.param('id'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    return c.json({ project })
  })

  // Overlay view for the UI: globals + this project's own rows. Project rows
  // shadow globals when ids collide (same rule the daemon uses at runtime).
  // Kept as a read-only endpoint — writes still go through /api/project-config
  // scoped to this project, so nobody accidentally edits a global from here.
  router.get('/:id/available-agents', (c) => {
    const id = c.req.param('id')
    if (!projectRepo.get(id)) return c.json({ error: 'Project not found', agents: [] }, 404)
    return c.json({ agents: agentRepo.visibleTo(id) })
  })

  router.get('/:id/available-system-prompts', (c) => {
    const id = c.req.param('id')
    if (!projectRepo.get(id)) return c.json({ error: 'Project not found', systemPrompts: [] }, 404)
    return c.json({ systemPrompts: systemPromptRepo.visibleTo(id) })
  })

  router.post('/', async (c) => {
    try {
      const body = await c.req.json()
      const validated = ProjectInputSchema.parse(body)
      if (projectRepo.get(validated.id)) {
        return c.json({ error: `Project ${validated.id} already exists` }, 409)
      }
      const project = projectRepo.upsert(validated)
      invalidateConfigCache()
      // Spawn a manager for the new project so polling starts immediately.
      reloadManagers()
      return c.json({ project }, 201)
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.patch('/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const existing = projectRepo.get(id)
      if (!existing) return c.json({ error: 'Project not found' }, 404)
      const patch = ProjectPatchSchema.parse(await c.req.json())
      // patch.source can be: undefined (leave alone), null (clear), object (replace)
      const mergedSource =
        patch.source === undefined ? existing.source : (patch.source ?? undefined)
      const merged = {
        id,
        name: patch.name ?? existing.name,
        language: patch.language ?? existing.language,
        source: mergedSource,
        settings: patch.settings ?? existing.settings,
      }
      // Invalidate cached source for the OLD config before the write, so any
      // in-flight reads settle against the fresh URL on the next request.
      sourceFactory.invalidate(existing)
      const project = projectRepo.upsert(merged)
      invalidateConfigCache()
      // URL / name may have changed — recycle the poll loop so it points at
      // the new source.
      reloadManagers()
      return c.json({ project })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  // Preview endpoint for the "delete cascade" confirmation dialog. Counts
  // the rows that would be removed alongside the project so the UI can
  // show something like "3 agentes, 2 system prompts, 5 statuses".
  router.get('/:id/cascade-preview', (c) => {
    const id = c.req.param('id')
    if (!projectRepo.get(id)) return c.json({ error: 'Project not found' }, 404)
    const db = getDb()
    const count = (sql: string): number => (db.query(sql).get(id) as { c: number }).c
    return c.json({
      agents: count('SELECT COUNT(*) AS c FROM agents WHERE project_id = ?'),
      systemPrompts: count('SELECT COUNT(*) AS c FROM system_prompts WHERE project_id = ?'),
      statuses: count('SELECT COUNT(*) AS c FROM statuses WHERE project_id = ?'),
    })
  })

  // Default DELETE is archive (soft — hides from the list, preserves data).
  // Add ?cascade=true for a hard delete that removes the project and every
  // row it owns (agents, system_prompts, statuses scoped to this project).
  // Globals (project_id IS NULL) are left alone.
  router.delete('/:id', (c) => {
    const id = c.req.param('id')
    const existing = projectRepo.get(id)
    if (!existing) return c.json({ error: 'Project not found' }, 404)
    const cascade = c.req.query('cascade') === 'true'
    sourceFactory.invalidate(existing)
    if (cascade) {
      projectRepo.deleteCascade(id)
    } else {
      projectRepo.archive(id)
    }
    invalidateConfigCache()
    // Project is gone (or hidden) — recycle the poll loop.
    reloadManagers()
    return c.json({ ok: true, cascade })
  })

  // ─── Polling pause (in-memory, per-project) ───────────────────────────
  // Not persisted: paused projects resume on daemon restart. See
  // @ia-flow/issue-sources dispatch/polling-pause.ts for the rationale.
  router.get('/polling/paused', (c) => {
    return c.json({ paused: listPausedProjects() })
  })

  router.get('/:id/polling', (c) => {
    const id = c.req.param('id')
    if (!projectRepo.get(id)) return c.json({ error: 'Project not found' }, 404)
    return c.json({ projectId: id, paused: isProjectPaused(id) })
  })

  router.post('/:id/polling/pause', (c) => {
    const id = c.req.param('id')
    if (!projectRepo.get(id)) return c.json({ error: 'Project not found' }, 404)
    pauseProject(id)
    broadcast.send({ type: 'project:polling', projectId: id, paused: true })
    return c.json({ projectId: id, paused: true })
  })

  router.post('/:id/polling/resume', (c) => {
    const id = c.req.param('id')
    if (!projectRepo.get(id)) return c.json({ error: 'Project not found' }, 404)
    resumeProject(id)
    broadcast.send({ type: 'project:polling', projectId: id, paused: false })
    return c.json({ projectId: id, paused: false })
  })

  return router
}
