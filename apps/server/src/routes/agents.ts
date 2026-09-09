import { TaskChatReplySchema, TaskChatRequestSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import {
  type AssistInput,
  AssistUpstreamError,
  AssistValidationError,
  type AssistWithAiUseCase,
} from '../application/use-cases/AssistWithAiUseCase.js'

// El JSON Schema que se le fuerza al modelo en modo `fill_form` — espejo
// manual de `TaskChatReplySchema` (packages/shared). No se deriva con
// zod-to-json-schema: el resto del repo (`AiAssistPanel.vue`) ya arma estos
// schemas a mano, y sumar una dependencia para un literal de 15 líneas no
// pagaba.
const TASK_CHAT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: 'La respuesta en lenguaje natural, en español, que ve el operador.',
    },
    actions: {
      type: 'array',
      description:
        'Acciones staged que el operador puede aplicar. Vacío si la respuesta no propone ningún cambio.',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['set-field'] },
          itemId: {
            type: 'string',
            description: 'El id de la tarea, tal como viene en el contexto.',
          },
          itemTitle: { type: 'string' },
          field: { type: 'string', description: 'El nombre del campo a cambiar, p. ej. "status".' },
          value: { type: 'string' },
        },
        required: ['type', 'itemId', 'field', 'value'],
      },
    },
  },
  required: ['reply', 'actions'],
} as const

function buildTaskChatPrompt(body: {
  messages: { role: string; content: string }[]
  tasks: unknown[]
}): string {
  const tasksBlock = JSON.stringify(body.tasks, null, 2)
  const historyBlock = body.messages
    .map((m) => `${m.role === 'user' ? 'Operador' : 'Asistente'}: ${m.content}`)
    .join('\n\n')
  return [
    'Sos el asistente de tareas de un board de ia-flow. Contestás preguntas del operador sobre',
    'la lista de tareas del proyecto activo, en español y en pocas líneas.',
    '',
    'Si tu respuesta implica cambiar el campo de una tarea (p. ej. moverla de status), no lo',
    'apliques vos: proponelo como una acción `set-field` en `actions`. El operador decide si la',
    'aplica. Si no hay ningún cambio que proponer, `actions` va vacío.',
    '',
    '## Tareas visibles',
    tasksBlock,
    '',
    '## Conversación',
    historyBlock,
  ].join('\n')
}

/** Comparten la misma taxonomía de errores que `/assist`: validación → 400,
 *  falla upstream → su status, cualquier otra cosa → 500 genérico. */
function assistErrorResponse(err: unknown): { body: { error: string }; status: 400 | 500 } {
  if (err instanceof AssistValidationError) return { body: { error: err.message }, status: 400 }
  if (err instanceof AssistUpstreamError) return { body: { error: err.message }, status: 500 }
  return { body: { error: String(err) }, status: 500 }
}

async function handleTaskChat(assistWithAi: AssistWithAiUseCase, json: unknown) {
  const parsed = TaskChatRequestSchema.safeParse(json)
  if (!parsed.success) {
    return {
      body: { error: parsed.error.issues.map((i) => i.message).join('; ') },
      status: 400 as const,
    }
  }
  const { projectId, messages, tasks } = parsed.data
  if (!messages.some((m) => m.role === 'user')) {
    return {
      body: { error: 'messages must include at least one user message' },
      status: 400 as const,
    }
  }

  try {
    const result = await assistWithAi.execute({
      mode: 'generate',
      agentId: 'task-chat',
      projectId,
      description: buildTaskChatPrompt({ messages, tasks }),
      responseSchema: TASK_CHAT_RESPONSE_SCHEMA,
    })
    const reply = TaskChatReplySchema.safeParse(result.fields)
    if (!reply.success) {
      return {
        body: { error: 'El asistente no devolvió una respuesta con el formato esperado.' },
        status: 502 as const,
      }
    }
    return { body: reply.data, status: 200 as const }
  } catch (err) {
    return assistErrorResponse(err)
  }
}

export function createAgentsRouter(assistWithAi: AssistWithAiUseCase) {
  const app = new Hono()

  app.post('/assist', async (c) => {
    let body: AssistInput
    try {
      body = (await c.req.json()) as AssistInput
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    try {
      const result = await assistWithAi.execute(body)
      return c.json(result)
    } catch (err) {
      const { body: errBody, status } = assistErrorResponse(err)
      return c.json(errBody, status)
    }
  })

  app.post('/task-chat', async (c) => {
    let json: unknown
    try {
      json = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }
    const { body, status } = await handleTaskChat(assistWithAi, json)
    return c.json(body, status)
  })

  return app
}
