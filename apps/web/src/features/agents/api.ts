import type { McpCatalogEntry } from '@ia-flow/shared'
import axios from 'axios'

// Todo el HTTP del dominio de agentes pasa por acá, y siempre por axios.
//
// No es sólo la convención de apps/web: el token del server elegido lo pone un
// INTERCEPTOR de axios (features/servers/selection.ts). Un `fetch` crudo no
// pasa por él, sale sin credencial y el server responde 401 — que es
// exactamente cómo el picker de tools del editor de agentes terminó vacío sin
// que nada lo dijera.

export async function assistAgent(body: {
  mode: 'generate' | 'refine'
  description?: string
  currentPrompt?: string
  agentId?: string
  systemPromptIds?: string[]
  agentVariables?: Array<{ key: string; value: string }>
  agentSystemPromptIds?: string[]
  templateContext?: 'system-prompt' | 'agent-prompt'
  projectId?: string
}): Promise<{ prompt: string }> {
  const res = await axios.post('/api/agents/assist', body)
  return res.data
}

/** La misma llamada que `assistAgent`, para quien además espera `fields` —
 *  el panel las usa cuando el pedido lleva un `responseSchema`. */
export async function assistAgentRaw(
  body: Record<string, unknown>,
): Promise<{ prompt?: string; fields?: Record<string, unknown>; error?: string }> {
  const res = await axios.post('/api/agents/assist', body)
  return res.data ?? {}
}

export interface ToolCatalogEntry {
  name: string
  description: string
  aliases?: string[]
}

/**
 * El catálogo de tools que el editor le puede ofrecer a un agente.
 *
 * `query` es el ámbito ya armado por el llamador (`?projectId=…` o
 * `?scope=global`): un agente de proyecto ve las globales más las definidas
 * por SU proyecto, y uno global sólo las globales.
 */
export async function fetchToolCatalog(query = ''): Promise<ToolCatalogEntry[]> {
  const res = await axios.get<ToolCatalogEntry[]>(`/api/tools${query}`)
  return res.data
}

export async function fetchMcpCatalog(): Promise<McpCatalogEntry[]> {
  const res = await axios.get<{ entries: McpCatalogEntry[] }>('/api/mcp-catalog')
  return res.data.entries
}
