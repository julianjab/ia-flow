import type { Condition } from '../pipeline/Condition.js'
import type { SlackMemberRef } from './Repo.js'

export interface SourceRef {
  kind: string
  config?: Record<string, unknown>
}

export interface SystemPromptRef {
  id?: string
  text?: string
}

export interface ProjectSettings {
  name?: string
  language?: string
  maxConcurrentDispatches?: number
  systemPrompts?: SystemPromptRef[]
  slackReviewChannel?: string | null
  slackReviewers?: SlackMemberRef[] | null
  /** Pipelines globales que este proyecto decidió no correr (IRuleRepository.visibleTo). */
  disabledPipelineIds?: string[] | null
  /** ANDeado contra el `when` de CADA pipeline que corre en este proyecto, globales incluidas. */
  baseWhen?: Condition[] | null
  daemonMode?: 'webhook' | 'polling'
}

export interface ProjectProps {
  id: string
  name: string
  language?: string
  source?: SourceRef
  settings?: ProjectSettings
  createdAt?: string
  updatedAt?: string
  archivedAt?: string | null
}

/**
 * El contenedor de más arriba: fuente de issues + settings de operación.
 * Los repos y los agentes NO viven embebidos acá — son entidades propias
 * indexadas por projectId (ver Repo, y Agent que se autoindexa por id).
 *
 * Se autoindexa por id (estático) igual que Execution — mismo motivo: una
 * clase `ProjectRegistry` aparte sólo para `Map + get` no paga su lugar.
 * `Engine.dispatch` usa `Project.resolve(event.scope?.projectId)` en vez de
 * recibir un registry inyectado.
 */
export class Project {
  private static readonly byId = new Map<string, Project>()

  static register(project: Project): void {
    Project.byId.set(project.id, project)
  }

  static resolve(id: string): Project | undefined {
    return Project.byId.get(id)
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    Project.byId.clear()
  }

  readonly id: string
  name: string
  language?: string
  source?: SourceRef
  settings: ProjectSettings
  readonly createdAt?: string
  updatedAt?: string
  archivedAt?: string | null

  constructor(props: ProjectProps) {
    this.id = props.id
    this.name = props.name
    this.language = props.language
    this.source = props.source
    this.settings = props.settings ?? {}
    this.createdAt = props.createdAt
    this.updatedAt = props.updatedAt
    this.archivedAt = props.archivedAt ?? null
  }

  isArchived(): boolean {
    return this.archivedAt != null
  }

  /**
   * ¿Este proyecto apagó este pipeline heredado? Dos condiciones, las dos
   * importan: `pipeline.id` está en la lista Y el pipeline es GLOBAL
   * (`pipeline.projectId == null`) — lo segundo evita que apagar uno global
   * se lleve puesto uno propio que comparta id por casualidad (uno propio
   * ya tiene su propio `enabled`, que es donde se apaga). Toma un shape
   * mínimo en vez de `Pipeline` completo para no crear el ciclo Project↔Pipeline
   * (Pipeline.matches ya importa Project).
   */
  disablesPipeline(pipeline: { id: string; projectId?: string | null }): boolean {
    if (pipeline.projectId != null) return false
    return this.settings.disabledPipelineIds?.includes(pipeline.id) ?? false
  }
}
