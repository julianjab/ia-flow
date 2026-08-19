import { AgentDefinitionSchema, invalidateMemoized } from '@ia-flow/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { agentRepo, configRepo, projectRepo, repoRepo } from '../composition/container.js'
import { repoNameError } from './agents-crud-validation.js'

// configRepo.getConfig is @memoize'd (short TTL, see SqliteProjectConfigRepo)
// to collapse TaskDispatcher's per-item calls within one scan cycle — but it
// shares that cache with GET /api/project-config, so a write here has to
// drop it explicitly or the UI can read a stale agent list for up to the TTL.
function invalidateConfigCache(): void {
  invalidateMemoized(configRepo, 'getConfig')
}

const ReorderRequestSchema = z.object({
  ids: z.array(z.string()),
})

function validRepoNames(projectId: string | null): Set<string> {
  if (!projectId) return new Set()
  return new Set(repoRepo.listByProject(projectId).map((r) => r.name))
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
      const candidate = { ...parsed, projectId: s.target }
      const repoErr = repoNameError(candidate, validRepoNames(candidate.projectId))
      if (repoErr) return c.json({ error: repoErr }, 400)
      // Append al final del scope. Ojo: NO se puede usar `inScope.length` —
      // las posiciones no están normalizadas a 0..n-1 (la migración 036 las
      // asignó desde un contador global que atraviesa proyectos y globales),
      // así que `length` caería en medio del rango y el agente nuevo se
      // colaría al frente de la selección. `max + 1` respeta la numeración
      // que ya exista. Reordenar es responsabilidad exclusiva de /reorder.
      const positions = agentRepo.inScope(s.target).map((a) => a.position ?? 0)
      const position = positions.length ? Math.max(...positions) + 1 : 0
      agentRepo.upsert(candidate, position, s.target)
      invalidateConfigCache()
      return c.json({ agent: candidate }, 201)
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  // Persists a caller-chosen order (`position` = index in `ids`) so the
  // "first agent that matches, by position" tie-break in the engine is
  // user-controlled. Scoped exactly like the rest of this router.
  router.put('/reorder', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const parsed = ReorderRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'Invalid payload', issues: parsed.error.issues }, 400)
    }
    const inScope = agentRepo.inScope(s.target)
    const knownIds = new Set(inScope.map((a) => a.id))
    const unknown = parsed.data.ids.filter((id) => !knownIds.has(id))
    if (unknown.length > 0) {
      return c.json({ error: `ids not found in this scope: ${unknown.join(', ')}` }, 400)
    }
    agentRepo.setPositions(parsed.data.ids, s.target)
    invalidateConfigCache()
    return c.json({ agents: agentRepo.inScope(s.target) })
  })

  router.put('/:id', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    const id = c.req.param('id')
    const inScope = agentRepo.inScope(s.target)
    const current = inScope.find((a) => a.id === id)
    if (!current) return c.json({ error: `Agent '${id}' not found in this scope` }, 404)
    try {
      const parsed = AgentDefinitionSchema.parse(await c.req.json())
      if (parsed.id !== id) return c.json({ error: 'Body id does not match URL id' }, 400)
      const candidate = { ...parsed, projectId: s.target }
      const repoErr = repoNameError(candidate, validRepoNames(candidate.projectId))
      if (repoErr) return c.json({ error: repoErr }, 400)
      // Preserva la posición actual: editar el prompt de un agente no debe
      // cambiar su prioridad de selección. Usar el índice en `inScope` sería
      // un bug silencioso — es el rango, no la posición, y las dos numeraciones
      // no coinciden (ver el comentario del POST).
      agentRepo.upsert(candidate, current.position ?? 0, s.target)
      invalidateConfigCache()
      return c.json({ agent: candidate })
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
    invalidateConfigCache()
    return c.json({ ok: true })
  })

  return router
}
