import {
  type TaskChatMessage,
  type TaskChatReply,
  TaskChatReplySchema,
  type TaskChatTaskContext,
  type UiContract,
} from '@ia-flow/shared'
import axios from 'axios'

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
 * El `uiContract` viaja como un dato más del payload: parte de él depende del
 * proyecto activo (los statuses reales del board), así que no puede ser una
 * constante de este módulo — lo arma el store con `buildTaskUiContract`.
 */
export async function sendTaskChatMessage(
  payload: {
    projectId: string
    message: string
    history: TaskChatMessage[]
    tasks: TaskChatTaskContext[]
    uiContract: UiContract
  },
  opts: { signal?: AbortSignal } = {},
): Promise<TaskChatReply> {
  const { data } = await axios.post('/api/tasks/assistant/chat', payload, { signal: opts.signal })
  return TaskChatReplySchema.parse(data)
}
