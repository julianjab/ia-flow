import { type AgentDefinition, AgentDefinitionSchema } from '@ia-flow/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { agentRepo, projectRepo } from '../composition/container.js'

// Human-readable warnings surfaced back in the response body when the caller
// is still using the deprecated `tools[]` / `disabledTools[]` fields instead
// of the issue #58 permission DSL. Non-blocking: the row still persists.
function legacyWarnings(a: AgentDefinition): string[] {
  const out: string[] = []
  if (a.tools?.length && !a.permissions?.length && !a.presetId) {
    out.push(
      "tools[] is deprecated — migrate to permissions[] or presetId (see issue #58). The runtime still accepts it and resolves aliases (e.g. 'read_file' → 'fs_read'), but the field will be removed in a future release.",
    )
  }
  if (a.disabledTools?.length) {
    out.push(
      'disabledTools[] is deprecated — express opt-outs by narrowing permissions[] instead. This field will be dropped by the 035 migration.',
    )
  }
  return out
}

// Granular CRUD for agents. Writes are scoped explicitly:
//   ?scope=global        → global rows (project_id IS NULL)
//   ?projectId=<id>      → that project's own rows
//
// Kept intentionally separate from the bulk /api/project-config PUT to avoid
// the "overlay leak" (where reading globals-through-a-project + bulk-saving
// promoted globals to project-owned rows). Overlay reads still live at
// /api/projects/:id/available-agents.
function resolveScope(
  c: Context,
): { ok: true; target: string | null } | { ok: false; error: string } {
  const scope = c.req.query('scope')
  if (scope === 'global') return { ok: true, target: null }
  const projectId = c.req.query('projectId')
  if (!projectId) return { ok: false, error: 'scope=global or projectId=<id> is required' }
  if (!projectRepo.get(projectId)) return { ok: false, error: `Project ${projectId} not found` }
  return { ok: true, target: projectId }
}

export function createAgentsCrudRouter() {
  const router = new Hono()

  router.get('/', (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    return c.json({ agents: agentRepo.inScope(s.target) })
  })

  router.post('/', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    try {
      const parsed = AgentDefinitionSchema.parse(await c.req.json())
      const existing = agentRepo.inScope(s.target).find((a) => a.id === parsed.id)
      if (existing)
        return c.json({ error: `Agent '${parsed.id}' already exists in this scope` }, 409)
      const position = agentRepo.inScope(s.target).length
      agentRepo.upsert({ ...parsed, projectId: s.target }, position, s.target)
      return c.json(
        { agent: { ...parsed, projectId: s.target }, warnings: legacyWarnings(parsed) },
        201,
      )
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.put('/:id', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    const id = c.req.param('id')
    const inScope = agentRepo.inScope(s.target)
    const idx = inScope.findIndex((a) => a.id === id)
    if (idx < 0) return c.json({ error: `Agent '${id}' not found in this scope` }, 404)
    try {
      const parsed = AgentDefinitionSchema.parse(await c.req.json())
      if (parsed.id !== id) return c.json({ error: 'Body id does not match URL id' }, 400)
      agentRepo.upsert({ ...parsed, projectId: s.target }, idx, s.target)
      return c.json({
        agent: { ...parsed, projectId: s.target },
        warnings: legacyWarnings(parsed),
      })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.delete('/:id', (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    const id = c.req.param('id')
    const inScope = agentRepo.inScope(s.target)
    if (!inScope.some((a) => a.id === id))
      return c.json({ error: `Agent '${id}' not found in this scope` }, 404)
    agentRepo.deleteById(id)
    return c.json({ ok: true })
  })

  return router
}
