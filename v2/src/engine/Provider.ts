import type { AgentRunInput, AgentRunOutput } from './Agent.js'
import type { ProviderKind } from './Tool.js'
import type { WorkspacePlan, WorkspaceRequest } from './Workspace.js'

export interface AdmissionRequest {
  agentId?: string
  /** Runs de este provider despachados por ESTE daemon — lo calcula el engine. */
  running: number
  /** maxConcurrentRuns declarado — ausente/0 = sin límite. */
  cap?: number
}

export interface Admission {
  accept: boolean
  reason?: string
  retryAfterMs?: number
}

export interface ProviderProps {
  id: string
  /** `sync`: el proceso que corre el modelo es el mismo que ejecuta las
   *  tools (anthropic-api local) — `bash_run`/`workspace_reset` sólo
   *  aplican acá. `async`: el modelo corre en un CLI aparte (tmux/iterm,
   *  remoto) que ya trae su propio Bash nativo — ahí las tools inyectadas
   *  son las que el daemon expone vía MCP, y `complete_task` sólo aplica
   *  acá. Determina qué `Tool.providerKinds` puede declarar un Agent que
   *  resuelva este Provider (ver Agent.execute). */
  kind: ProviderKind
  maxConcurrentRuns?: number
}

/**
 * A quién se le pide correr un Agent. El engine no decide si puede: le pasa
 * los hechos que ya tiene (`AdmissionRequest`) y el Provider responde — es
 * consultivo y fail-open (no reserva nada, y ante cualquier fallo interno
 * admite: un chequeo roto que congela el pipeline es peor que un run que
 * falla de verdad, porque ESE fallo sí se reporta).
 *
 * Se autoindexa por id igual que Agent/Project — mismo motivo: colección +
 * resolve sin lógica propia que justifique una clase `ProviderRegistry`
 * aparte.
 */
export abstract class Provider {
  private static readonly byId = new Map<string, Provider>()

  readonly id: string
  readonly kind: ProviderKind
  readonly maxConcurrentRuns?: number

  constructor(props: ProviderProps) {
    this.id = props.id
    this.kind = props.kind
    this.maxConcurrentRuns = props.maxConcurrentRuns
  }

  static register(provider: Provider): void {
    Provider.byId.set(provider.id, provider)
  }

  static resolve(id: string): Provider | undefined {
    return Provider.byId.get(id)
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    Provider.byId.clear()
  }

  /** Corre el loop de tools de este provider para un Agent ya resuelto. */
  abstract run(input: AgentRunInput): Promise<AgentRunOutput>

  /**
   * Default cuando el Provider no lo sobreescribe: aplica el cap declarado
   * (`maxConcurrentRuns`) y nada más — así el cap de la UI vale para todos
   * los providers sin que ninguno escriba una línea. Un Provider concreto
   * normalmente arranca llamando a este mismo default y agrega sus motivos
   * encima (ver RemoteAgentProvider en v1: resuelve el cap local gratis y
   * recién después sonda su agent-host).
   */
  async canAccept(req: AdmissionRequest): Promise<Admission> {
    const cap = req.cap ?? this.maxConcurrentRuns
    const within = cap == null || cap === 0 || req.running < cap
    return within ? { accept: true } : { accept: false, reason: 'cap alcanzado' }
  }

  /** Default: sin workspace propio — el caller usa los paths que ya conoce
   *  (clone local, sin worktree). Un Provider concreto que sí sabe
   *  provisionar (worktree, remoto) sobreescribe esto entero. */
  async prepareWorkspace(req: WorkspaceRequest): Promise<WorkspacePlan> {
    return { repoPaths: {} }
  }
}
