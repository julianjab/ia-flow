export type ProviderKind = 'sync' | 'async'

export interface ToolProps {
  name: string
  /** Ausente = disponible en los dos mundos. `bash_run`/`workspace_reset`
   *  son `['sync']` (en async el CLI ya trae su Bash nativo); `complete_task`
   *  es `['async']` (en sync el run lo cierra el engine leyendo el outcome,
   *  no el modelo). */
  providerKinds?: ProviderKind[]
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
  private static readonly byName = new Map<string, Tool>()

  readonly name: string
  readonly providerKinds?: ProviderKind[]

  constructor(props: ToolProps) {
    this.name = props.name
    this.providerKinds = props.providerKinds
  }

  static register(tool: Tool): void {
    throw new Error('not implemented — Tool.byName.set(tool.name, tool)')
  }

  static resolve(name: string): Tool | undefined {
    throw new Error('not implemented — Tool.byName.get(name)')
  }

  /** Ausente `providerKinds` ⇒ disponible en cualquiera. */
  supports(kind: ProviderKind): boolean {
    throw new Error(
      'not implemented — this.providerKinds == null || this.providerKinds.includes(kind)',
    )
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    throw new Error('not implemented — Tool.byName.clear()')
  }
}
