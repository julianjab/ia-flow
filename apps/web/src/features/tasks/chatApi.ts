import {
  type TaskChatMessage,
  type TaskChatReply,
  TaskChatReplySchema,
  type TaskChatTaskContext,
} from '@ia-flow/shared'
import axios from 'axios'

/**
 * Le pregunta al asistente sobre la lista de tareas del proyecto activo.
 *
 * `messages` viaja completo (incluyendo el mensaje nuevo ya empujado al
 * final) porque el server no guarda historial de chat — la sesión vive sólo
 * mientras el drawer está montado (ver `TaskChatDrawer.vue`).
 */
export async function sendTaskChatMessage(
  projectId: string,
  messages: TaskChatMessage[],
  tasks: TaskChatTaskContext[],
): Promise<TaskChatReply> {
  const { data } = await axios.post('/api/agents/task-chat', { projectId, messages, tasks })
  return TaskChatReplySchema.parse(data)
}
