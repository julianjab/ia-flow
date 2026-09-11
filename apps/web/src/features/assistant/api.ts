import { type AssistantChatMessage, AssistantChatMessageSchema } from '@ia-flow/shared'
import axios from 'axios'

/**
 * Manda un mensaje del bubble button. A diferencia de `sendTaskChatMessage`,
 * esto NO devuelve la respuesta del asistente en el body — es async por
 * naturaleza (pasa por el bus de eventos + la regla fija del agente, ver
 * `routes/assistant-chat.ts`). La respuesta llega por WS
 * (`assistant:message`, ver `store.ts`).
 */
export async function postAssistantMessage(payload: {
  sessionId: string
  text: string
  projectId?: string
  taskId?: string
}): Promise<void> {
  await axios.post('/api/assistant/chat', payload)
}

/** Hidrata el historial de una sesión al abrir el widget o reconectar el WS. */
export async function fetchAssistantMessages(sessionId: string): Promise<AssistantChatMessage[]> {
  const { data } = await axios.get(`/api/assistant/sessions/${sessionId}/messages`)
  return AssistantChatMessageSchema.array().parse(data.messages)
}
