export type TaskType = 'functional' | 'technical'
export type TaskCommentOrigin = 'issue' | 'pr' | 'pr-review'

export interface TaskComment {
  id?: string
  author: string
  body: string
  createdAt: string
  origin: TaskCommentOrigin
  /** `path:línea` cuando origin es 'pr-review'. */
  location?: string
  threadId?: string
}

export interface PullRequestRef {
  number: number
  url: string
  state: 'open' | 'closed' | 'merged'
  headRef?: string
}

export interface TaskProps {
  id: string
  title: string
  description: string
  type: TaskType
  /** []=sin refinar, ['X']=ejecutable, ['X','Y',…]=épica. */
  repos: string[]
  status: string
  createdAt: string
  approvedAt?: string
  error?: string
  agentWorking?: boolean
  issueNumber?: number
  issueUrl?: string
  labels?: string[]
  assignees?: string[]
  /** Campos custom del board de la fuente (ej. columnas de GitHub Project). */
  fields?: Record<string, string>
  comments?: TaskComment[]
  projectId?: string
  branch?: string
  pullRequests?: PullRequestRef[]
  /** FunctionalPRD | TechnicalPRDs en v1 — sin tipar acá, es contenido del refiner. */
  prd?: unknown
  sections?: Record<string, string>
}

/**
 * Un issue normalizado, agnóstico de la fuente (GitHub/local/lo que sea).
 * NO participa del camino Engine→Pipeline→Agent — ese camino sólo mueve
 * `DomainEvent.payload` (genérico) entre pasos, nunca esta clase ni ninguna
 * instancia con comportamiento propio (ver AgentRunInput.payload en
 * Agent.ts). `Task` queda disponible para quien la necesite fuera de ese
 * camino — persistencia, UI — pero el engine no la conoce.
 */
export class Task {
  readonly id: string
  title: string
  description: string
  readonly type: TaskType
  repos: string[]
  status: string
  readonly createdAt: string
  approvedAt?: string
  error?: string
  agentWorking: boolean
  issueNumber?: number
  issueUrl?: string
  labels: string[]
  assignees: string[]
  fields: Record<string, string>
  comments: TaskComment[]
  projectId?: string
  branch?: string
  pullRequests: PullRequestRef[]
  prd?: unknown
  sections: Record<string, string>

  constructor(props: TaskProps) {
    this.id = props.id
    this.title = props.title
    this.description = props.description
    this.type = props.type
    this.repos = props.repos
    this.status = props.status
    this.createdAt = props.createdAt
    this.approvedAt = props.approvedAt
    this.error = props.error
    this.agentWorking = props.agentWorking ?? false
    this.issueNumber = props.issueNumber
    this.issueUrl = props.issueUrl
    this.labels = props.labels ?? []
    this.assignees = props.assignees ?? []
    this.fields = props.fields ?? {}
    this.comments = props.comments ?? []
    this.projectId = props.projectId
    this.branch = props.branch
    this.pullRequests = props.pullRequests ?? []
    this.prd = props.prd
    this.sections = props.sections ?? {}
  }

  get primaryRepo(): string | undefined {
    return this.repos[0]
  }

  isExecutable(): boolean {
    return this.repos.length === 1
  }

  isEpic(): boolean {
    return this.repos.length > 1
  }

  isRefined(): boolean {
    return this.repos.length >= 1
  }

  hasLabel(label: string): boolean {
    return this.labels.includes(label)
  }

  field(name: string): string | undefined {
    return this.fields[name]
  }

  openPullRequests(): PullRequestRef[] {
    return this.pullRequests.filter((pr) => pr.state === 'open')
  }

  transitionTo(status: string): void {
    this.status = status
  }
}
