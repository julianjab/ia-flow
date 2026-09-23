import type { Project } from '../domain/Project.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { PipelineActionEntry, PipelineExecutionContext } from './actions/PipelineActionEntry.js'
import { Conditional, type ConditionalProps } from './Conditional.js'

export interface PipelineProps extends ConditionalProps {
  id: string
  name?: string
  description?: string
  /** Tipos de DomainEvent que este pipeline escucha — al menos uno. */
  on: string[]
  /** Ámbito: null/ausente = sin restricción, un valor estrecha (fail-closed). */
  projectId?: string | null
  repoName?: string | null
  /** Cron que hace tickear este pipeline (junto con on: ['schedule.tick']). */
  schedule?: string
  enabled?: boolean
  position?: number
  /** Si matchea, impide que corran los pipelines de menor prioridad para este evento. */
  exclusive?: boolean
  do: PipelineActionEntry[]
  createdAt?: string
  updatedAt?: string
}

/**
 * Filtra eventos (matches/matchesText) y ejecuta su cadena de `do`, acumulando
 * el output de cada paso nombrado en ctx.steps para que los pasos siguientes
 * lo lean vía `{{steps.<id>.output}}`. `when`/`whenText` los hereda de
 * `Conditional` — acá sólo se compone con lo que le agrega a ese patrón:
 * `on`/`enabled`/ámbito/`baseWhen` del proyecto.
 */
export class Pipeline extends Conditional {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly on: string[]
  readonly projectId?: string | null
  readonly repoName?: string | null
  readonly schedule?: string
  readonly enabled: boolean
  readonly position: number
  readonly exclusive: boolean
  readonly do: PipelineActionEntry[]
  readonly createdAt?: string
  readonly updatedAt?: string

  constructor(props: PipelineProps) {
    super(props)
    this.id = props.id
    this.name = props.name
    this.description = props.description
    this.on = props.on
    this.projectId = props.projectId
    this.repoName = props.repoName
    this.schedule = props.schedule
    this.enabled = props.enabled ?? true
    this.position = props.position ?? 0
    this.exclusive = props.exclusive ?? false
    this.do = props.do
    this.createdAt = props.createdAt
    this.updatedAt = props.updatedAt
  }

  /**
   * Sólo los filtros puros: enabled, on, ámbito (projectId/repoName vs
   * event.scope), this.matchesConditions (heredado de Conditional) contra
   * this.when + baseWhen del proyecto, y — cuando `project` viaja — el
   * override `disabledPipelineIds` (este pipeline es global Y el proyecto la
   * apagó). `project` es opcional porque un evento puede no tener projectId
   * resoluble (Project.resolve sin esa fila, o el evento es cross-proyecto)
   * — ahí sólo corren los filtros que no lo necesitan.
   */
  matches(event: DomainEvent, project?: Project): boolean {
    throw new Error(
      'not implemented — this.enabled && this.on.includes(event.type) && matchScope(this, event) && ' +
        '!(project?.disablesPipeline(this) ?? false) && ' +
        'this.matchesConditions(event.payload, project?.settings.baseWhen ?? [])',
    )
  }

  /** Gate async aparte porque es impuro — delega en el heredado de Conditional. */
  async matchesText(event: DomainEvent): Promise<boolean> {
    return this.matchesConditionText(event.payload)
  }

  /**
   * Corre this.do en orden; cada paso puede leer ctx.steps de los anteriores
   * (input) y ctx.nextSchema del paso siguiente (para qué schema debe
   * cumplir su output, sólo cuando el siguiente es un AgentAction) —
   * recalculado antes de CADA step, no acumulativo como ctx.steps.
   */
  async execute(ctx: PipelineExecutionContext): Promise<Record<string, unknown>> {
    throw new Error(
      'not implemented — for (i, step) of this.do.entries(): if !step.shouldRun(ctx) mark skipped y seguir; ' +
        'const next = this.do[i + 1]; ' +
        'ctx.nextSchema = next instanceof AgentAction ? Agent.resolve(next.agentId)?.output : undefined; ' +
        'try { out = await step.run(ctx); if (step.id) ctx.steps[step.id] = out } ' +
        'catch (e) { if (!step.continueOnError) throw e }',
    )
  }
}
