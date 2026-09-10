import { TaskChatRequestSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import {
  AssistUpstreamError,
  AssistValidationError,
} from '../application/use-cases/AssistWithAiUseCase.js'
import type { TaskChatUseCase } from '../application/use-cases/TaskChatUseCase.js'
import { createLogger } from '../logger.js'

const log = createLogger('task-chat')

type BroadcastFn = (msg: object) => void

/** Comparten la misma taxonomía de errores que `/assist`. */
function assistErrorResponse(err: unknown): { body: { error: string }; status: 400 | 500 | 502 } {
  if (err instanceof AssistValidationError) return { body: { error: err.message }, status: 400 }
  if (err instanceof AssistUpstreamError) {
    const status = err.status === 502 ? 502 : 500
    return { body: { error: err.message }, status }
  }
  return { body: { error: String(err) }, status: 500 }
}

/**
 * `POST /api/tasks/assistant/chat` — el borde HTTP de la barra de comandos
 * de `TareasSection.vue` (ver #215/#216).
 *
 * **Progreso en vivo.** Por el MISMO canal WS que ya usa el resto de la app
 * (`broadcastFn`) se emiten eventos `task-chat:progress`:
 * - `started` / `done` / `error` — el ciclo de vida del turno completo.
 * - `reading` — uno por cada `get_task_detail`/`list_tasks`/`search_tasks`
 *   que el modelo dispara mientras arma la respuesta (`TaskChatUseCase` →
 *   `AssistWithAiUseCase.runFormFill`, ver #215). Trae `tool`, `index`
 *   (1-based, el N-ésimo tool call de este turno) y `label` (texto legible,
 *   p. ej. `Leyendo la tarea #42`) — no hay un `M` total porque el modelo
 *   decide en vuelo cuántas lecturas necesita, no hay forma de anticiparlo.
 *
 * Además, cancelación real: el front aborta el `fetch` y esta ruta propaga
 * `c.req.raw.signal` hasta el `fetch` a Anthropic (en cada vuelta del loop
 * de lectura), así que "detener" corta la llamada upstream de verdad, sin
 * inventar un endpoint de cancelación aparte.
 */
export function createTaskChatRouter(taskChat: TaskChatUseCase, broadcast: BroadcastFn) {
  const app = new Hono()

  app.post('/chat', async (c) => {
    let json: unknown
    try {
      json = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    const parsed = TaskChatRequestSchema.safeParse(json)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400)
    }

    const chatId = crypto.randomUUID()
    broadcast({
      type: 'task-chat:progress',
      chatId,
      projectId: parsed.data.projectId,
      phase: 'started',
    })

    try {
      const result = await taskChat.execute(parsed.data, {
        signal: c.req.raw.signal,
        onProgress: (e) => {
          broadcast({
            type: 'task-chat:progress',
            chatId,
            projectId: parsed.data.projectId,
            phase: 'reading',
            tool: e.tool,
            index: e.index,
            label: e.label,
          })
        },
      })
      broadcast({
        type: 'task-chat:progress',
        chatId,
        projectId: parsed.data.projectId,
        phase: 'done',
      })
      return c.json(result)
    } catch (err) {
      broadcast({
        type: 'task-chat:progress',
        chatId,
        projectId: parsed.data.projectId,
        phase: 'error',
      })
      if (c.req.raw.signal.aborted) {
        log.info(
          { chatId, projectId: parsed.data.projectId },
          'task-chat: cancelado por el cliente',
        )
        return c.json({ error: 'cancelled' }, 400)
      }
      const { body, status } = assistErrorResponse(err)
      return c.json(body, status)
    }
  })

  return app
}
