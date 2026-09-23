import { Catalog } from '../shared/Catalog.js'

export type ProviderKind = 'sync' | 'async'

export interface ToolProps {
  name: string
  /** Ausente = disponible en los dos mundos. `bash_run`/`workspace_reset`
   *  son `['sync']` (en async el CLI ya trae su Bash nativo); `complete_task`
   *  es `['async']` (en sync el run lo cierra el engine leyendo el outcome,
   *  no el modelo). */
  providerKinds?: ProviderKind[]
  /** true para tools que escriben (fs_write, bash_run, workspace_reset...) —
   *  es lo que Agent.hasWriteTools() consulta para decidir si intersecta
   *  writePaths contra el WorkspacePlan del Provider. */
  isWrite?: boolean
}

/**
 * Catálogo de tools que un `Agent` puede declarar (`Agent.tools`). El
 * dominio sólo conoce NOMBRE + a qué tipo de provider está restringida —
 * el schema de cada tool para el modelo y su ejecución real (el loop,
 * fs_read, bash_run, los ~30 tools de v1) son responsabilidad exclusiva del
 * Provider. El dominio no los modela porque nunca los ejecuta: sólo
 * necesita poder responder "¿este Agent puede declarar esta tool dado
 * dónde va a correr?", que es una restricción cross-provider (no depende
 * de qué modelo ni de qué MCP haya del otro lado).
 */
export class Tool {
  private static readonly catalog = new Catalog<Tool>((t) => t.name)

  readonly name: string
  readonly providerKinds?: ProviderKind[]
  readonly isWrite: boolean

  constructor(props: ToolProps) {
    this.name = props.name
    this.providerKinds = props.providerKinds
    this.isWrite = props.isWrite ?? false
  }

  static register(tool: Tool): void {
    Tool.catalog.register(tool)
  }

  static resolve(name: string): Tool | undefined {
    return Tool.catalog.resolve(name)
  }

  /** Ausente `providerKinds` ⇒ disponible en cualquiera. */
  supports(kind: ProviderKind): boolean {
    return this.providerKinds == null || this.providerKinds.includes(kind)
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    Tool.catalog.reset()
  }
}
