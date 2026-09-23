import type { DomainEvent } from '../events/DomainEvent.js'
import type { RuleActionEntry, RuleExecutionContext } from './actions/RuleActionEntry.js'
import type { Condition } from './Condition.js'

export interface RuleProps {
  id: string
  name?: string
  description?: string
  /** Tipos de DomainEvent que esta regla escucha — al menos uno. */
  on: string[]
  /** Ámbito: null/ausente = sin restricción, un valor estrecha (fail-closed). */
  projectId?: string | null
  repoName?: string | null
  when?: Condition[]
  /** Gate impuro (Haiku) — descarta la regla aunque sea la única candidata. */
  whenText?: string
  /** Cron que hace tickear esta regla (junto con on: ['schedule.tick']). */
  schedule?: string
  enabled?: boolean
  position?: number
  /** Si matchea, impide que corran las reglas de menor prioridad para este evento. */
  exclusive?: boolean
  do: RuleActionEntry[]
  createdAt?: string
  updatedAt?: string
}

/**
 * Filtra eventos (matches/matchesText) y ejecuta su cadena de `do`, acumulando
 * el output de cada paso nombrado en ctx.steps para que los pasos siguientes
 * lo lean vía `{{steps.<id>.output}}`.
 */
export class Rule {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly on: string[]
  readonly projectId?: string | null
  readonly repoName?: string | null
  readonly when: Condition[]
  readonly whenText?: string
  readonly schedule?: string
  readonly enabled: boolean
  readonly position: number
  readonly exclusive: boolean
  readonly do: RuleActionEntry[]
  readonly createdAt?: string
  readonly updatedAt?: string

  constructor(props: RuleProps) {
    this.id = props.id
    this.name = props.name
    this.description = props.description
    this.on = props.on
    this.projectId = props.projectId
    this.repoName = props.repoName
    this.when = props.when ?? []
    this.whenText = props.whenText
    this.schedule = props.schedule
    this.enabled = props.enabled ?? true
    this.position = props.position ?? 0
    this.exclusive = props.exclusive ?? false
    this.do = props.do
    this.createdAt = props.createdAt
    this.updatedAt = props.updatedAt
  }

  /** Sólo los filtros puros: enabled, on, ámbito (projectId/repoName vs event.scope), when. */
  matches(event: DomainEvent): boolean {
    throw new Error(
      'not implemented — this.enabled && this.on.includes(event.type) && matchScope(this, event) && ' +
        'Condition.evaluateAll(this.when, event.payload)',
    )
  }

  /** Gate async aparte porque es impuro (clasificador tipo Haiku), cacheado por (rule, evento). */
  async matchesText(event: DomainEvent): Promise<boolean> {
    if (this.whenText == null) return true
    throw new Error('not implemented — clasificador contra this.whenText')
  }

  /** Corre this.do en orden; cada paso puede leer ctx.steps de los anteriores. */
  async execute(ctx: RuleExecutionContext): Promise<Record<string, unknown>> {
    throw new Error(
      'not implemented — for each step in this.do: if !step.shouldRun(ctx) mark skipped y seguir; ' +
        'try { out = await step.run(ctx); if (step.id) ctx.steps[step.id] = out } ' +
        'catch (e) { if (!step.continueOnError) throw e }',
    )
  }
}
