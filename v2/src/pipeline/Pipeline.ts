import type { Project } from '../domain/Project.js'
import { AgentAction } from './actions/AgentAction.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import { Agent } from '../engine/Agent.js'
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
    if (!this.enabled) return false
    if (!this.on.includes(event.type)) return false
    if (!this.matchesScope(event)) return false
    if (project?.disablesPipeline(this) ?? false) return false
    return this.matchesConditions(event.payload, project?.settings.baseWhen ?? [])
  }

  /** `projectId`/`repoName` null/ausente = sin restricción; un valor
   *  estrecha (fail-closed) — el evento tiene que traer ESE valor exacto
   *  en `scope`, no alcanza con que esté presente cualquiera. */
  private matchesScope(event: DomainEvent): boolean {
    if (this.projectId != null && event.scope?.projectId !== this.projectId) return false
    if (this.repoName != null && !(event.scope?.repos ?? []).includes(this.repoName)) return false
    return true
  }

  /** Gate async aparte porque es impuro — delega en el heredado de Conditional. */
  async matchesText(event: DomainEvent): Promise<boolean> {
    return this.matchesConditionText(event.payload)
  }

  /**
   * Corre this.do en orden; cada paso puede leer ctx.steps de los anteriores
   * (input) y ctx.nextSchema del paso siguiente — recalculado antes de CADA
   * step, no acumulativo como ctx.steps. Cuando el siguiente es un
   * AgentAction, `nextSchema` es el `expectedInput` DE ESE AGENTE (lo que
   * él necesita para arrancar), nunca su `output` (lo que él mismo produce
   * al cerrar) — son dos contratos distintos del mismo Agent, y mezclarlos
   * hacía que el paso actual se constriñera contra el cierre de otro
   * agente en vez de contra lo que ese agente realmente espera recibir. Un
   * paso saltado (`shouldRun` false) no deja rastro en `ctx.steps`.
   */
  async execute(ctx: PipelineExecutionContext): Promise<Record<string, unknown>> {
    const runCtx: PipelineExecutionContext = { ...ctx, pipelineId: this.id }
    for (let i = 0; i < this.do.length; i++) {
      const step = this.do[i]
      if (!step.shouldRun(runCtx)) continue
      const next = this.do[i + 1]
      runCtx.nextSchema =
        next instanceof AgentAction ? Agent.resolve(next.agentId)?.expectedInput : undefined
      try {
        const out = await step.run(runCtx)
        if (step.id) runCtx.steps[step.id] = out
      } catch (err) {
        if (!step.continueOnError) throw err
      }
    }
    return runCtx.steps
  }
}
