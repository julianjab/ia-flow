import type { Step, StepContext } from '../engine/Step.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { Condition } from './Condition.js'

export interface RuleProps {
  id: string
  /** Tipos de DomainEvent que esta regla escucha. */
  on: string[]
  when?: Condition[]
  /** Gate impuro (Haiku), igual que whenText en v1 — se evalúa último. */
  whenText?: string
  do: Step[]
  /** Si true, ninguna otra Rule matcheada por el mismo evento corre después de esta. */
  exclusive?: boolean
  enabled?: boolean
  position?: number
  projectId?: string
  repoName?: string
}

/**
 * Filtra eventos (matches) y ejecuta su cadena de `do` (execute), pasando el
 * output de cada Step como input del siguiente. El primer Step recibe el
 * payload del evento.
 */
export class Rule {
  readonly id: string
  readonly on: string[]
  readonly when: Condition[]
  readonly whenText?: string
  readonly do: Step[]
  readonly exclusive: boolean
  readonly enabled: boolean
  readonly position: number
  readonly projectId?: string
  readonly repoName?: string

  constructor(props: RuleProps) {
    this.id = props.id
    this.on = props.on
    this.when = props.when ?? []
    this.whenText = props.whenText
    this.do = props.do
    this.exclusive = props.exclusive ?? false
    this.enabled = props.enabled ?? true
    this.position = props.position ?? 0
    this.projectId = props.projectId
    this.repoName = props.repoName
  }

  /** Sólo los filtros puros (on + when). whenText se evalúa aparte porque es async/impuro. */
  matches(event: DomainEvent): boolean {
    throw new Error(
      'not implemented — this.enabled && this.on.includes(event.type) && this.when.every(...)',
    )
  }

  async matchesText(event: DomainEvent): Promise<boolean> {
    throw new Error('not implemented — clasificador tipo Haiku sobre this.whenText, cacheado')
  }

  async execute(event: DomainEvent): Promise<unknown> {
    throw new Error(
      'not implemented — encadena this.do: input = event.payload; for each step, input = await step.run(input, ctx)',
    )
  }
}
