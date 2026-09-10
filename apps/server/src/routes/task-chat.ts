import { TaskChatRequestSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  AssistUpstreamError,
  AssistValidationError,
} from '../application/use-cases/AssistWithAiUseCase.js'
import type { TaskChatUseCase } from '../application/use-cases/TaskChatUseCase.js'
import { createLogger } from '../logger.js'

const log = createLogger('task-chat')

type BroadcastFn = (msg: object) => void

/**
 * Comparten la misma taxonomía de errores que `/assist`.
 *
 * `AssistUpstreamError.status` viaja con el status HTTP REAL que devolvió
 * Anthropic (`res.status` en `AssistWithAiUseCase`). Antes se aplanaba todo
 * a 500 salvo 502, así que un 429 (rate limit) llegaba indistinguible de un
 * fallo genérico y el front no podía mostrar "esperá y reintentá".
 *
 * Pero NO todo status ajeno es seguro de propagar verbatim: 401/403/404 ya
 * tienen su propio significado EN ESTA APP (401 = "tu x-ia-flow-token está
 * mal", ver apps/web/src/features/servers/api.ts) — si Anthropic devuelve
 * 401 por una API key revocada del daemon, reenviarlo tal cual le hace
 * creer al operador que el problema es SU token de ia-flow, no la
 * credencial del servidor. Sólo se propagan los códigos donde el cliente
 * tiene una acción real y sin ambigüedad con la semántica propia de la
 * app: 408/409 (reintentable), 429 (rate limit), 529 (overloaded, propio
 * de Anthropic) y 5xx genérico. Todo lo demás es "el upstream falló" → 502.
 */
function assistErrorResponse(err: unknown): {
  body: { error: string }
  status: ContentfulStatusCode
} {
  if (err instanceof AssistValidationError) return { body: { error: err.message }, status: 400 }
  if (err instanceof AssistUpstreamError) {
    const status = isPropagatableUpstreamStatus(err.status) ? err.status : 502
    return { body: { error: err.message }, status }
  }
  return { body: { error: String(err) }, status: 500 }
}

const PROPAGATABLE_UPSTREAM_STATUSES = new Set([408, 409, 429, 529])

function isPropagatableUpstreamStatus(status: number): status is ContentfulStatusCode {
  if (PROPAGATABLE_UPSTREAM_STATUSES.has(status)) return true
  return Number.isInteger(status) && status >= 500 && status <= 599
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
