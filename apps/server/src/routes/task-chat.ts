import { TaskAnnotationSchema, TaskChatRequestSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import {
  AssistUpstreamError,
  AssistValidationError,
} from '../application/use-cases/AssistWithAiUseCase.js'
import type { TaskChatUseCase } from '../application/use-cases/TaskChatUseCase.js'
import type { ITaskAnnotationRepository } from '../domain/ports/ITaskAnnotationRepository.js'
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
 * `POST /api/tasks/assistant/chat` + CRUD mínimo de anotaciones — el borde
 * HTTP de la barra de comandos de `TareasSection.vue` (ver #215/#216).
 *
 * **Progreso en vivo — parcial, a propósito.** El diseño final (10c) pide
 * "leyendo N de M tareas" mientras el asistente lee — eso requiere el
 * tool-loop de lectura de #214 (`get_task_detail`/`list_tasks`/
 * `search_tasks`), que TODAVÍA NO EXISTE en este repo (el contexto de tareas
 * hoy se manda inline en el request, igual que antes). Sin esa pieza no hay
 * conteo real que emitir. Lo que SÍ se implementa:
 * - un evento `task-chat:progress` (`started`/`done`/`error`) por el MISMO
 *   canal WS que ya usa el resto de la app (`broadcastFn`), para que el
 *   front pueda mostrar "Pensando…" sin colgarse;
 * - cancelación real: el front aborta el `fetch` y esta ruta propaga
 *   `c.req.raw.signal` hasta el `fetch` a Anthropic (`TaskChatUseCase` →
 *   `AssistWithAiUseCase.runFormFill`), así que "detener" corta la llamada
 *   upstream de verdad, sin inventar un endpoint de cancelación aparte.
 */
export function createTaskChatRouter(
  taskChat: TaskChatUseCase,
  taskAnnotationRepo: ITaskAnnotationRepository,
  broadcast: BroadcastFn,
) {
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
      const result = await taskChat.execute(parsed.data, { signal: c.req.raw.signal })
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

  // ─── Anotaciones (acción `note`) ─────────────────────────────────────────
  //
  // Sin use-case propio: es un passthrough de CRUD sin decisión de negocio
  // (ver la regla "routes → repo" del CLAUDE.md de la raíz) — la única
  // verificación que importa (el `taskId` es una tarea real) ya la hizo
  // `TaskChatUseCase` antes de que el chip llegara al operador.

  app.get('/notes', async (c) => {
    const projectId = c.req.query('projectId')
    const taskId = c.req.query('taskId')
    if (!projectId || !taskId) {
      return c.json({ error: 'projectId and taskId query params are required' }, 400)
    }
    const notes = await taskAnnotationRepo.listByTask(projectId, taskId)
    return c.json({ notes })
  })

  app.post('/notes', async (c) => {
    let json: unknown
    try {
      json = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }
    const parsed = TaskAnnotationSchema.omit({ id: true, createdAt: true }).safeParse(json)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400)
    }
    const note = await taskAnnotationRepo.create({
      ...parsed.data,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    })
    return c.json({ note }, 201)
  })

  app.delete('/notes/:id', async (c) => {
    const id = c.req.param('id')
    const ok = await taskAnnotationRepo.delete(id)
    if (!ok) return c.json({ error: `Annotation '${id}' not found` }, 404)
    return c.json({ ok: true })
  })

  return app
}
