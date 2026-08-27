import type { AgentMemoryEntry } from '@ia-flow/shared'

/**
 * Almacén del KV que un agente persiste entre runs.
 *
 * El namespace `(agentId, projectId)` NO es un parámetro más: es la identidad
 * de la fila. Toda operación lo lleva, así que no existe una lectura que cruce
 * agentes — el aislamiento es estructural, no una convención que cada llamador
 * tenga que acordarse de aplicar. `projectId: ''` es la memoria global del
 * agente.
 *
 * `search` está en el port (y no resuelto filtrando lo que devuelve `list`)
 * justamente para poder cambiar el `LIKE` del MVP por FTS5 o un índice
 * vectorial sin tocar las tools.
 */
export interface IAgentMemoryRepository {
  get(agentId: string, projectId: string, key: string): AgentMemoryEntry | null
  /** Todas las entradas del namespace, ordenadas por key. */
  list(agentId: string, projectId: string): AgentMemoryEntry[]
  /** Entradas cuya key O value contienen `term` (case-insensitive). */
  search(agentId: string, projectId: string, term: string): AgentMemoryEntry[]
  upsert(entry: AgentMemoryEntry): void
  /** `true` si había algo que borrar. */
  deleteByKey(agentId: string, projectId: string, key: string): boolean
}
