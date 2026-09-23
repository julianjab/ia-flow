export type TaskType = 'functional' | 'technical'

export interface TaskProps {
  id: string
  title: string
  description: string
  type: TaskType
  repos: string[]
  status: string
  projectId?: string
  labels?: string[]
  branch?: string
  agentWorking?: boolean
  fields?: Record<string, string>
}

/** Un issue normalizado, agnóstico de la fuente (GitHub/local/lo que sea). */
export class Task {
  readonly id: string
  title: string
  description: string
  readonly type: TaskType
  repos: string[]
  status: string
  projectId?: string
  labels: string[]
  branch?: string
  agentWorking: boolean
  fields: Record<string, string>

  constructor(props: TaskProps) {
    this.id = props.id
    this.title = props.title
    this.description = props.description
    this.type = props.type
    this.repos = props.repos
    this.status = props.status
    this.projectId = props.projectId
    this.labels = props.labels ?? []
    this.branch = props.branch
    this.agentWorking = props.agentWorking ?? false
    this.fields = props.fields ?? {}
  }

  get primaryRepo(): string | undefined {
    return this.repos[0]
  }

  /** []=sin refinar, ['X']=ejecutable, ['X','Y',…]=épica — ver TaskSchema.repos en v1. */
  isExecutable(): boolean {
    return this.repos.length === 1
  }

  isEpic(): boolean {
    return this.repos.length > 1
  }

  hasLabel(label: string): boolean {
    return this.labels.includes(label)
  }

  field(name: string): string | undefined {
    return this.fields[name]
  }

  transitionTo(status: string): void {
    this.status = status
  }
}
