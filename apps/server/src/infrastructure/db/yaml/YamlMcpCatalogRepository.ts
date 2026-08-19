import { readFileSync } from 'fs'
import { type McpCatalogEntry, McpCatalogEntrySchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import type { IMcpCatalogRepository } from '../../../domain/ports/IMcpCatalogRepository.js'

// Read-only IMcpCatalogRepository backed by a static YAML file instead of
// the `mcp_catalog` SQLite table. Same rationale as YamlAgentRepository: a
// fixed engine deployment (e.g. a container running only a refiner) ships
// its MCP servers as deploy config, not something edited at runtime through
// the CRUD UI. Mutating methods throw instead of silently no-op-ing so a
// stray call from routes/mcp-catalog.ts fails loud rather than pretending
// to persist.
const YAML_MCP_CATALOG_SCHEMA = McpCatalogEntrySchema.array()

function readEntries(filePath: string): McpCatalogEntry[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(
      `YamlMcpCatalogRepository: no se pudo leer '${filePath}': ${(err as Error).message}`,
    )
  }

  const parsed = parseYaml(raw)
  const result = YAML_MCP_CATALOG_SCHEMA.safeParse(parsed ?? [])
  if (!result.success) {
    throw new Error(
      `YamlMcpCatalogRepository: '${filePath}' no cumple McpCatalogEntrySchema[]: ${result.error.message}`,
    )
  }
  return result.data
}

function readOnly(op: string): never {
  throw new Error(
    `YamlMcpCatalogRepository es de solo lectura (${op} no soportado) — editá el archivo YAML y reiniciá el proceso.`,
  )
}

export class YamlMcpCatalogRepository implements IMcpCatalogRepository {
  // Loaded once at construction: this repo backs a static, deploy-time
  // catalog (see class doc), so there is no writer to invalidate a cache
  // against — re-reading the file on every call would just add I/O.
  private readonly entries: McpCatalogEntry[]

  constructor(filePath: string) {
    // Unlike agents, McpCatalogEntry has no `position` field — SQLite's
    // order comes from a DB column the router assigns on write. For a
    // static file, the declared array order IS the position.
    this.entries = readEntries(filePath)
  }

  list(): McpCatalogEntry[] {
    return [...this.entries]
  }

  get(id: string): McpCatalogEntry | null {
    return this.entries.find((e) => e.id === id) ?? null
  }

  upsert(_entry: McpCatalogEntry, _position: number): void {
    readOnly('upsert')
  }

  deleteById(_id: string): void {
    readOnly('deleteById')
  }
}
