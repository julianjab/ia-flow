import type { McpCatalogEntry } from '@ia-flow/shared'

export interface IMcpCatalogRepository {
  list(): McpCatalogEntry[]
  get(id: string): McpCatalogEntry | null
  upsert(entry: McpCatalogEntry, position: number): void
  deleteById(id: string): void
}
