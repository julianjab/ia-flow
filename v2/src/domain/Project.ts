import type { Condition } from '../rules/Condition.js'
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
  /** Reglas globales que este proyecto decidió no correr (IRuleRepository.visibleTo). */
  disabledRuleIds?: string[] | null
  /** ANDeado contra el `when` de CADA regla que corre en este proyecto, globales incluidas. */
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

/** El contenedor de más arriba: fuente de issues + settings de operación.
 *  Los repos y los agentes NO viven embebidos acá — son entidades propias
 *  indexadas por projectId (ver Repo, y Agent vía AgentRegistry). */
export class Project {
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
   * ¿Este proyecto apagó esta regla heredada? Dos condiciones, las dos
   * importan: `rule.id` está en la lista Y la regla es GLOBAL
   * (`rule.projectId == null`) — lo segundo evita que apagar una global se
   * lleve puesta una regla propia que comparta id por casualidad (una propia
   * ya tiene su propio `enabled`, que es donde se apaga). Toma un shape
   * mínimo en vez de `Rule` completo para no crear el ciclo Project↔Rule
   * (Rule.matches ya importa Project).
   */
  disablesRule(rule: { id: string; projectId?: string | null }): boolean {
    if (rule.projectId != null) return false
    return this.settings.disabledRuleIds?.includes(rule.id) ?? false
  }
}
