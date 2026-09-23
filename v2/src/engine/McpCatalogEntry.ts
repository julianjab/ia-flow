export type McpTransport = 'http' | 'stdio'

export interface McpCatalogEntryProps {
  id: string
  name?: string
  transport: McpTransport
  /** http: url + headers, pueden traer `${SECRETO}` (resuelto antes de
   *  viajar). stdio: command + args — se descarta en el camino remoto,
   *  Anthropic no puede abrir un proceso del otro lado. */
  config: Record<string, unknown>
}

/** Catálogo de servidores MCP que un `Agent` referencia por id
 *  (`Agent.mcpCatalogIds`) — se autoindexa igual que el resto del dominio. */
export class McpCatalogEntry {
  private static readonly byId = new Map<string, McpCatalogEntry>()

  readonly id: string
  readonly name?: string
  readonly transport: McpTransport
  readonly config: Record<string, unknown>

  constructor(props: McpCatalogEntryProps) {
    this.id = props.id
    this.name = props.name
    this.transport = props.transport
    this.config = props.config
  }

  static register(entry: McpCatalogEntry): void {
    throw new Error('not implemented — McpCatalogEntry.byId.set(entry.id, entry)')
  }

  static resolve(id: string): McpCatalogEntry | undefined {
    throw new Error('not implemented — McpCatalogEntry.byId.get(id)')
  }

  static resolveAll(ids: string[]): McpCatalogEntry[] {
    throw new Error(
      'not implemented — ids.map(id => McpCatalogEntry.resolve(id)).filter((e): e is McpCatalogEntry => e != null)',
    )
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    throw new Error('not implemented — McpCatalogEntry.byId.clear()')
  }
}
