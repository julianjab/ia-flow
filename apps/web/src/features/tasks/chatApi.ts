import {
  type TaskChatMessage,
  type TaskChatReply,
  TaskChatReplySchema,
  type TaskChatTaskContext,
} from '@ia-flow/shared'
import axios from 'axios'
import { TASK_UI_CONTRACT } from '@/features/tasks/uiContract'

/**
 * Le pregunta al asistente sobre la lista de tareas del proyecto activo.
 *
 * `history` viaja SIN el mensaje nuevo (va aparte en `message`) porque el
 * server no guarda historial de chat — la sesión vive sólo en memoria del
 * store mientras la sección de Tareas está montada (sin hilo — ver #215).
 *
 * `signal` deja que el operador corte la respuesta con "detener": el server
 * propaga el abort hasta el fetch a Anthropic (`routes/task-chat.ts`), así
 * que cancelar corta la llamada upstream de verdad.
 *
 * El `uiContract` lo pone esta capa y no el caller: es una propiedad del
 * BUNDLE (qué sabe dibujar este cliente), no de la pantalla que pregunta.
 * Pasarlo por parámetro obligaría a cada caller a acordarse de mandarlo, y el
 * que se olvide degrada en silencio a un asistente sin UI generativa.
 */
export async function sendTaskChatMessage(
  payload: {
    projectId: string
    message: string
    history: TaskChatMessage[]
    tasks: TaskChatTaskContext[]
  },
  opts: { signal?: AbortSignal } = {},
): Promise<TaskChatReply> {
  const { data } = await axios.post(
    '/api/tasks/assistant/chat',
    { ...payload, uiContract: TASK_UI_CONTRACT },
    { signal: opts.signal },
  )
  return TaskChatReplySchema.parse(data)
}
