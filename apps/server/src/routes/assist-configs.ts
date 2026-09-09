import { AssistCallerConfigSchema, SystemPromptRefSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { IAssistCallerConfigRepository } from '../domain/ports/IAssistCallerConfigRepository.js'
import type { ISystemPromptRepository } from '../domain/ports/ISystemPromptRepository.js'

// Body de PUT: sólo `systemPrompts` — el `agentId` viene de la URL, no del
// body (evita el caso "el body dice otro agentId que la URL").
const PutBodySchema = z.object({
  systemPrompts: z.array(SystemPromptRefSchema).optional(),
})

/**
 * CRUD de `assist_caller_configs` — ver issue #225 y
 * `domain/ports/IAssistCallerConfigRepository.ts`. Sin scope de proyecto:
 * la clave es el `agentId` ad-hoc del caller (hoy `task-chat`,
 * `repo-description`), no un proyecto.
 */
export function createAssistConfigsRouter(
  repo: IAssistCallerConfigRepository,
  systemPromptRepo: ISystemPromptRepository,
) {
  const app = new Hono()

  app.get('/', (c) => c.json({ configs: repo.list() }))

  app.get('/:agentId', (c) => {
    const config = repo.getById(c.req.param('agentId'))
    if (!config) return c.json({ error: `No hay config para '${c.req.param('agentId')}'` }, 404)
    return c.json({ config })
  })

  app.put('/:agentId', async (c) => {
    const agentId = c.req.param('agentId')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }
    const parsedBody = PutBodySchema.safeParse(body)
    if (!parsedBody.success) return c.json({ error: parsedBody.error.message }, 400)

    const parsed = AssistCallerConfigSchema.safeParse({ agentId, ...parsedBody.data })
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)

    // Rechazar acá, no dejar que un id mal escrito degrade en silencio en el
    // próximo run — ver AssistWithAiUseCase.resolveCallerConfigBlocks: un id
    // que no resuelve nunca queda como el ÚNICO motivo de blocks vacíos (esa
    // función ya cae al fallback si esto pasa), pero es más barato avisar
    // acá que confiar en ese fallback. `inScope()` sin scope: esta config es
    // global, así que un id de CUALQUIER proyecto es válido.
    const catalog = systemPromptRepo.inScope()
    const unknownIds = (parsed.data.systemPrompts ?? [])
      .filter((ref): ref is string => typeof ref === 'string')
      .filter((id) => !catalog.some((sp) => sp.id === id))
    if (unknownIds.length) {
      return c.json({ error: `system prompt id(s) not found: ${unknownIds.join(', ')}` }, 400)
    }

    repo.upsert(parsed.data)
    return c.json({ config: parsed.data })
  })

  app.delete('/:agentId', (c) => {
    const agentId = c.req.param('agentId')
    if (!repo.getById(agentId)) return c.json({ error: `No hay config para '${agentId}'` }, 404)
    repo.deleteById(agentId)
    return c.json({ ok: true })
  })

  return app
}
