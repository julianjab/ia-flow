import { HookToolEventSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { createLogger } from '../logger.js'

// Endpoint que consume el `PostToolUse` hook de Claude Code corriendo bajo
// `iterm-claude` / `tmux-claude`. Cada POST se traduce en DOS entradas en
// `daemon.log` — `tool.call` y `tool.result` — con exactamente los mismos
// campos (`event`, `runId`, `tool`, `toolUseId`, `input`, `result`) que emite
// el provider `anthropic-api` desde adapters/anthropic/provider.ts. Al
// escribir vía `createLogger()` se disparan también los broadcasts WS de
// `logger.ts`, así que la UI web ve estos eventos en vivo sin cambios.
//
// Por qué un endpoint y no escritura directa al file: múltiples invocaciones
// paralelas del hook (Claude Code corre tools en paralelo) escribiendo al
// mismo NDJSON corrompen líneas; delegando en el server serializamos vía el
// event loop de Bun + pino transport.
export function createHookEventsRouter() {
  const app = new Hono()
  const log = createLogger('hook-tool-use')

  app.post('/', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = HookToolEventSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'Invalid payload', issues: parsed.error.issues }, 400)
    }

    const { runId, toolName, toolUseId, input, result } = parsed.data

    // Formato idéntico al de anthropic/provider.ts (líneas 303-315) para que
    // el drawer de ejecuciones en la web use el MISMO parser y agrupamiento
    // por `toolUseId`. No renombrar campos sin actualizar el provider API.
    log.info({ event: 'tool.call', runId, tool: toolName, toolUseId, input }, 'Tool call')
    if (result !== undefined) {
      log.info({ event: 'tool.result', runId, tool: toolName, toolUseId, result }, 'Tool result')
    }

    return c.json({ ok: true })
  })

  return app
}
