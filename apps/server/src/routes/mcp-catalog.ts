import { McpCatalogEntrySchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { mcpCatalogRepo } from '../composition/container.js'

export function createMcpCatalogRouter() {
  const router = new Hono()

  router.get('/', (c) => c.json({ entries: mcpCatalogRepo.list() }))

  router.post('/', async (c) => {
    try {
      const parsed = McpCatalogEntrySchema.parse(await c.req.json())
      if (mcpCatalogRepo.get(parsed.id))
        return c.json({ error: `Entry '${parsed.id}' already exists` }, 409)
      const position = mcpCatalogRepo.list().length
      mcpCatalogRepo.upsert(parsed, position)
      return c.json({ entry: parsed }, 201)
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.put('/:id', async (c) => {
    const id = c.req.param('id')
    const existing = mcpCatalogRepo.get(id)
    if (!existing) return c.json({ error: `Entry '${id}' not found` }, 404)
    try {
      const parsed = McpCatalogEntrySchema.parse(await c.req.json())
      if (parsed.id !== id) return c.json({ error: 'Body id does not match URL id' }, 400)
      const entries = mcpCatalogRepo.list()
      const idx = entries.findIndex((e) => e.id === id)
      mcpCatalogRepo.upsert(parsed, idx >= 0 ? idx : entries.length)
      return c.json({ entry: parsed })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  router.delete('/:id', (c) => {
    const id = c.req.param('id')
    if (!mcpCatalogRepo.get(id)) return c.json({ error: `Entry '${id}' not found` }, 404)
    mcpCatalogRepo.deleteById(id)
    return c.json({ ok: true })
  })

  return router
}
