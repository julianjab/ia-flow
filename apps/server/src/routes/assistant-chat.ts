import { CHAT_MESSAGE, createEvent } from '@ia-flow/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { chatSessionRepo, eventBus } from '../composition/container.js'
import { createLogger } from '../logger.js'
import { CHAT_PROJECT_ID } from '../system-agents/index.js'

const log = createLogger('assistant-chat')

const PostMessageSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
  // Contexto de dónde estaba parado el operador cuando mandó el mensaje —
  // se guarda con la sesión para que el agente lo tenga, sin que la sesión
  // DEPENDA de ese proyecto/tarea (ver ChatSessionSource).
  projectId: z.string().optional(),
  taskId: z.string().optional(),
})

/**
 * `POST /api/assistant/chat` — el borde HTTP del bubble button de
 * `apps/web`. A diferencia de `task-chat.ts` (síncrono, responde con el
 * texto del modelo en el body), esto es async por naturaleza: el mensaje
 * entra como un evento (`chat.message`) que dispara al agente vía la regla
 * fija de `base-agents.yaml`, y la respuesta llega por el canal WS
 * (`assistant:message`, emitido desde `ChatSessionTaskSource.postComment`)
 * — no por el body de este POST, que sólo confirma que el mensaje quedó
 * registrado y publicado.
 */
export function createAssistantChatRouter() {
  const app = new Hono()

  app.post('/chat', async (c) => {
    let json: unknown
    try {
      json = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }
    const parsed = PostMessageSchema.safeParse(json)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400)
    }
    const { sessionId, text, projectId, taskId } = parsed.data

    chatSessionRepo.ensure(sessionId, { projectId, taskId })
    chatSessionRepo.appendMessage(sessionId, 'user', text)

    const event = createEvent({
      type: CHAT_MESSAGE,
      source: 'assistant-chat',
      // `issueId` es lo que `resolveEventItem` (composition/actions.ts) usa
      // para resolver el `IssueItem` vía `ChatSessionSource.getItemById` —
      // mismo camino genérico que cualquier evento de GitHub.
      scope: { projectId: CHAT_PROJECT_ID, issueId: sessionId },
      payload: { sessionId, text },
    })
    // Fire-and-forget: el turno del agente puede tardar varios segundos, y
    // el front ya escucha la respuesta por WS — no tiene sentido bloquear
    // esta request hasta que termine.
    eventBus.publish(event).catch((err: unknown) => {
      log.error({ err, sessionId }, 'No se pudo publicar chat.message')
    })

    return c.json({ ok: true }, 202)
  })

  // Para hidratar el historial al abrir el widget o reconectar el WS.
  app.get('/sessions/:id/messages', (c) => {
    const messages = chatSessionRepo.listMessages(c.req.param('id'))
    return c.json({ messages })
  })

  return app
}
