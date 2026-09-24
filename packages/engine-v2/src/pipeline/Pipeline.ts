import type { Project } from '../domain/Project.js'
import { AgentAction, type AgentActionProps } from './actions/AgentAction.js'
import { EmitAction, type EmitActionProps } from './actions/EmitAction.js'
import { HttpAction, type HttpActionProps } from './actions/HttpAction.js'
import { RefAction, type RefActionProps } from './actions/RefAction.js'
import { ScriptAction, type ScriptActionProps } from './actions/ScriptAction.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import { Agent } from '../engine/Agent.js'
import { Condition } from './Condition.js'
import type { PipelineActionEntry, PipelineExecutionContext } from './actions/PipelineActionEntry.js'
import { Conditional, type ConditionalProps } from './Conditional.js'

export interface PipelineProps extends ConditionalProps {
  id: string
  /** Tipos de DomainEvent que este pipeline escucha — al menos uno. */
  on: string[]
  /** Ámbito: null/ausente = sin restricción, un valor estrecha (fail-closed). */
  projectId?: string | null
  repoName?: string | null
  enabled?: boolean
  position?: number
  /** Si matchea, impide que corran los pipelines de menor prioridad para este evento. */
  exclusive?: boolean
  do: PipelineActionEntry[]
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
  readonly on: string[]
  readonly projectId?: string | null
  readonly repoName?: string | null
  readonly enabled: boolean
  readonly position: number
  readonly exclusive: boolean
  readonly do: PipelineActionEntry[]

  constructor(props: PipelineProps) {
    super(props)
    this.id = props.id
    this.on = props.on
    this.projectId = props.projectId
    this.repoName = props.repoName
    this.enabled = props.enabled ?? true
    this.position = props.position ?? 0
    this.exclusive = props.exclusive ?? false
    this.do = props.do
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

  /**
   * Traducción pura (sin I/O) de una fila de `RuleSchema` (v1,
   * `packages/shared/src/rules.ts`) a una instancia de `Pipeline`. `name`/
   * `description`/`schedule`/`createdAt`/`updatedAt` de la fila se
   * descartan a propósito — son justo los campos que el purge de
   * agnosticismo le sacó a `Pipeline` por no tener ningún lector real.
   * Leer la fila de la base es responsabilidad de un repo/port aparte; esto
   * sólo sabe traducir forma, no persistir ni cachear nada.
   */
  static fromRow(row: PipelineRow): Pipeline {
    return new Pipeline({
      id: row.id,
      on: row.on,
      projectId: row.projectId,
      repoName: row.repoName,
      when: Condition.fromRows(row.when),
      whenText: row.whenText,
      enabled: row.enabled,
      position: row.position,
      exclusive: row.exclusive,
      do: row.do.map(Pipeline.actionFromRow),
    })
  }

  /**
   * Dispatcha por el discriminante `action` de `RuleActionSchema` (v1) —
   * ojo que NO es `kind` (el campo de v2): `RuleActionEntrySchema` usa
   * `action` como discriminante de su union, `PipelineActionEntry.kind` es
   * el nombre que eligió v2 para lo mismo.
   *
   * `row.when` normalizado ACÁ (no en el cast de abajo): es JSON crudo
   * (`WhenConditionSchema[]`/shorthand), no instancias de `Condition` — sin
   * esto, `Conditional.matchesConditions` reventaría llamando `.evaluate()`
   * sobre un objeto plano.
   */
  private static actionFromRow(row: PipelineActionRow): PipelineActionEntry {
    const base = { ...row, when: Condition.fromRows(row.when as Parameters<typeof Condition.fromRows>[0]) }
    switch (row.action) {
      case 'agent':
        return new AgentAction(base as unknown as AgentActionProps)
      case 'http':
        return new HttpAction(base as unknown as HttpActionProps)
      case 'emit':
        return new EmitAction(base as unknown as EmitActionProps)
      case 'script':
        return new ScriptAction(base as unknown as ScriptActionProps)
      case 'ref':
        return new RefAction(base as unknown as RefActionProps)
      default:
        throw new Error(`Pipeline.fromRow: acción desconocida "${(row as { action: string }).action}"`)
    }
  }
}

/** Fila cruda de `RuleSchema` (v1) — sólo los campos que `Pipeline.fromRow`
 *  lee; el resto de la fila (name/description/schedule/timestamps) es
 *  válido en v1 pero no tiene lector en v2, se ignora. */
export interface PipelineRow {
  id: string
  on: string[]
  projectId?: string | null
  repoName?: string | null
  when?: Parameters<typeof Condition.fromRows>[0]
  whenText?: string
  enabled?: boolean
  position?: number
  exclusive?: boolean
  do: PipelineActionRow[]
}

/** `action` es el discriminante real de `RuleActionSchema` en v1 — el resto
 *  de los campos varía por variante, `Pipeline.actionFromRow` los pasa tal
 *  cual al constructor de la subclase correspondiente. */
export type PipelineActionRow = { action: 'agent' | 'http' | 'emit' | 'script' | 'ref' } & Record<
  string,
  unknown
>

