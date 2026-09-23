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

  hasDisabledRule(ruleId: string): boolean {
    return this.settings.disabledRuleIds?.includes(ruleId) ?? false
  }
}
