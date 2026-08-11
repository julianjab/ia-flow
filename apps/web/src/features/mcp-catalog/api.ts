import type { McpCatalogEntry } from '@ia-flow/shared'
import axios from 'axios'

export async function listMcpCatalog(): Promise<McpCatalogEntry[]> {
  const { data } = await axios.get<{ entries: McpCatalogEntry[] }>('/api/mcp-catalog')
  return data.entries
}

export async function createMcpCatalogEntry(entry: McpCatalogEntry): Promise<McpCatalogEntry> {
  const { data } = await axios.post<{ entry: McpCatalogEntry }>('/api/mcp-catalog', entry)
  return data.entry
}

export async function updateMcpCatalogEntry(
  id: string,
  entry: McpCatalogEntry,
): Promise<McpCatalogEntry> {
  const { data } = await axios.put<{ entry: McpCatalogEntry }>(
    `/api/mcp-catalog/${encodeURIComponent(id)}`,
    entry,
  )
  return data.entry
}

export async function deleteMcpCatalogEntry(id: string): Promise<void> {
  await axios.delete(`/api/mcp-catalog/${encodeURIComponent(id)}`)
}
