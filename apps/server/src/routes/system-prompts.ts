import { SystemPromptDefSchema, invalidateMemoized } from '@ia-flow/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { configRepo, projectRepo, systemPromptRepo } from '../composition/container.js'

// See the matching comment in agents-crud.ts — configRepo.getConfig is
// memoized and shared with GET /api/project-config.
function invalidateConfigCache(): void {
  invalidateMemoized(configRepo, 'getConfig')
}

// Granular CRUD for system prompts. Same scope semantics as agents-crud.
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

export function createSystemPromptsRouter() {
  const router = new Hono()

  router.get('/', (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    return c.json({ systemPrompts: systemPromptRepo.inScope(s.target) })
  })

  router.post('/', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    try {
      const parsed = SystemPromptDefSchema.parse(await c.req.json())
      const existing = systemPromptRepo.inScope(s.target).find((p) => p.id === parsed.id)
      if (existing)
        return c.json({ error: `System prompt '${parsed.id}' already exists in this scope` }, 409)
      const position = systemPromptRepo.inScope(s.target).length
      systemPromptRepo.upsert({ ...parsed, projectId: s.target }, position, s.target)
      invalidateConfigCache()
      return c.json({ systemPrompt: { ...parsed, projectId: s.target } }, 201)
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.put('/:id', async (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    const id = c.req.param('id')
    const inScope = systemPromptRepo.inScope(s.target)
    const idx = inScope.findIndex((p) => p.id === id)
    if (idx < 0) return c.json({ error: `System prompt '${id}' not found in this scope` }, 404)
    try {
      const parsed = SystemPromptDefSchema.parse(await c.req.json())
      if (parsed.id !== id) return c.json({ error: 'Body id does not match URL id' }, 400)
      systemPromptRepo.upsert({ ...parsed, projectId: s.target }, idx, s.target)
      invalidateConfigCache()
      return c.json({ systemPrompt: { ...parsed, projectId: s.target } })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.delete('/:id', (c) => {
    const s = resolveScope(c)
    if (!s.ok) return c.json({ error: s.error }, 400)
    const id = c.req.param('id')
    const inScope = systemPromptRepo.inScope(s.target)
    if (!inScope.some((p) => p.id === id))
      return c.json({ error: `System prompt '${id}' not found in this scope` }, 404)
    systemPromptRepo.deleteById(id)
    invalidateConfigCache()
    return c.json({ ok: true })
  })

  return router
}
