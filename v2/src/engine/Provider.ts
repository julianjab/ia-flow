import type { Task } from '../domain/Task.js'
import type { AgentRunInput, AgentRunOutput } from './Agent.js'
import type { WorkspacePlan, WorkspaceRequest } from './Workspace.js'

export interface AdmissionRequest {
  task: Task
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
  readonly maxConcurrentRuns?: number

  constructor(props: ProviderProps) {
    this.id = props.id
    this.maxConcurrentRuns = props.maxConcurrentRuns
  }

  static register(provider: Provider): void {
    throw new Error('not implemented — Provider.byId.set(provider.id, provider)')
  }

  static resolve(id: string): Provider | undefined {
    throw new Error('not implemented — Provider.byId.get(id)')
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    throw new Error('not implemented — Provider.byId.clear()')
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
    throw new Error(
      'not implemented — const within = req.cap == null || req.cap === 0 || req.running < req.cap; ' +
        'return within ? { accept: true } : { accept: false, reason: "cap alcanzado" }',
    )
  }

  /** Ausente: el run usa los paths que el engine ya conoce (clone local, sin worktree). */
  async prepareWorkspace(req: WorkspaceRequest): Promise<WorkspacePlan> {
    throw new Error('not implemented — este Provider no soporta prepareWorkspace, usar paths locales')
  }
}
