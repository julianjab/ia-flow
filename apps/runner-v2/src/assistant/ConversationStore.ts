/**
 * Las conversaciones del asistente, guardadas a nombre del login de GitHub de quien preguntó: cada
 * una es de UN contexto (todo el runner, un proyecto, una tarea) y de UN agente del asistente, como
 * en la web. Es el puerto; la
 * implementación sobre SQLite vive en `storage/`.
 */
import type {
  AssistantConversationSummary,
  AssistantProposal,
  AssistantScope,
} from '@ia-flow/shared'

/** Un mensaje, como se guarda: las tareas por su ref (se muestran como estén al leerlas). */
export interface StoredTurn {
  role: 'user' | 'assistant'
  content: string
  proposals: AssistantProposal[]
  tasks: string[]
}

export interface StoredConversation extends AssistantConversationSummary {
  thread: Array<StoredTurn & { created_at: string }>
}

export interface ConversationStore {
  /** Una conversación nueva de `login` en `scope`, con `agent` (sin él, el de siempre); devuelve
   *  su id. */
  create(login: string, scope: AssistantScope, title: string, agent?: string): string
  /** Si la conversación existe y es de `login` (y, con `agent`, de ese agente). */
  owns(id: string, login: string, agent?: string): boolean
  /** Suma mensajes, juntos (un intercambio entero o nada). */
  append(id: string, turns: StoredTurn[]): void
  /** Las de `login`, de la más reciente a la más vieja; con `scope`, sólo las de ese contexto. */
  list(login: string, scope?: AssistantScope, limit?: number): AssistantConversationSummary[]
  get(id: string, login: string): StoredConversation | undefined
  /** Borra una de `login`; `false` si no era suya o no existe. */
  remove(id: string, login: string): boolean
  /** Borra las que no se tocan desde antes de `cutoff` (ISO). */
  prune(cutoff: string): void
}

/** La clave de un contexto: `general`, `project:<id>` o `task:<ref>`. */
export function scopeKey(scope: AssistantScope): string {
  switch (scope.kind) {
    case 'general':
      return 'general'
    case 'project':
      return `project:${scope.project_id}`
    case 'task':
      return `task:${scope.ref}`
  }
}

const TITLE_CHARS = 80

/** El título de una conversación: su primera pregunta, en una línea. */
export function conversationTitle(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim()
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line
}
