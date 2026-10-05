import { createLogger, traced } from '@ia-flow/telemetry'
import type { AgentRunResult } from '../agent/Agent.js'
import { type ErrorRoute, type ExitDefaults, routeTargets } from '../routing/ExitRoutes.js'
import type { Pause } from './actions/Pause.js'
import type { GroupResult, MemberVerdict, ParallelGroup } from './ParallelGroup.js'
import type { StepRun, StepVia } from './Pipeline.js'
import type { PipelineGraph } from './PipelineGraph.js'
import {
  INTERRUPTION_STEP,
  type InterruptionReport,
  type PipelineExecutionContext,
  type Runnable,
} from './Runnable.js'
import { stepTrace } from './tracing.js'

/**
 * Corre UN paso de una pipeline y lo que su resultado pide: si eligió una salida, su `report`
 * (el cierre del turno, ANTES que los destinos: el siguiente agente tiene que ver ese comentario)
 * y sus destinos en orden; si tiró, el `onError` que le toca; si lo interrumpieron mientras
 * corría, su `onInterrupt` en vez de todo eso. Cada paso que corre abre su span.
 */
export class StepRunner {
  readonly log = createLogger('agent-engine.pipeline')

  constructor(
    private readonly pipelineId: string,
    private readonly graph: PipelineGraph,
    private readonly defaults: ExitDefaults,
  ) {}

  /**
   * Corre `step` si su `when` lo deja. Devuelve la pausa si el paso —o un destino de la salida que
   * eligió— pidió pausar: la pipeline corta ahí.
   *
   * `handleErrors: false` para los pasos que corren DENTRO de un `onError`: si fallara, por
   * ejemplo, el `+blocked` del proyecto, volver a aplicar ese mismo `onError` sería un loop.
   */
  async run(
    step: Runnable,
    input: unknown,
    ctx: PipelineExecutionContext,
    via: StepVia,
    handleErrors = true,
  ): Promise<Pause | undefined> {
    return (await this.attempt(step, input, ctx, via, handleErrors)).paused
  }

  /** Como `run`, y además si el paso corrió o su `when`/`whenText` lo salteó — lo que necesita
   *  una pipeline `firstMatch` para saber cuándo cortar. */
  async attempt(
    step: Runnable,
    input: unknown,
    ctx: PipelineExecutionContext,
    via: StepVia,
    handleErrors = true,
  ): Promise<{ ran: boolean; paused?: Pause }> {
    if (!step.shouldRun(ctx)) return { ran: false }
    const payload = ctx.event.payload
    const subject = typeof payload === 'object' && payload !== null ? payload : {}
    const textMismatch = await step.explainText(subject, ctx.classifier, ctx.event)
    if (textMismatch) {
      this.log.info(`${this.pipelineId}: ${step.id ?? 'paso'} no corre — ${textMismatch}`)
      return { ran: false }
    }
    const run = await this.runDue(step, input, ctx, via, handleErrors)
    return 'paused' in run && run.paused ? { ran: true, paused: run.paused } : { ran: true }
  }

  @traced(stepTrace)
  private async runDue(
    step: Runnable,
    input: unknown,
    ctx: PipelineExecutionContext,
    _via: StepVia,
    handleErrors = true,
  ): Promise<StepRun> {
    let out: unknown
    try {
      out = step.members
        ? await this.runGroup(step as ParallelGroup, ctx)
        : await step.run(ctx, input)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      // Interrumpido: lo que haya hecho al parar (incluso fallar) ya no decide nada.
      if (this.interruptedIn(step, ctx)) {
        return { output: undefined, interrupted: await this.interrupt(step, error.message, ctx) }
      }
      const handling = handleErrors ? this.errorHandling(step, ctx) : null
      if (!handling && !step.continueOnError) throw err
      if (!handling) return { error, handledBy: 'continueOnError' }
      if (step.id) ctx.steps[step.id] = { error: error.message }
      await this.runErrorRoute(handling.report, handling.route, error, ctx)
      return { error, handledBy: 'onError' }
    }
    if (this.interruptedIn(step, ctx)) {
      if (step.id) ctx.steps[step.id] = out
      const report = await this.interrupt(step, progressOf(step, out), ctx)
      return { output: out, interrupted: report }
    }
    const outcome = step.outcome(out)
    if (outcome.kind === 'pause') {
      return { output: outcome.pause.describe(), paused: outcome.pause }
    }
    if (step.id) ctx.steps[step.id] = out
    if (outcome.kind === 'output') return { output: out }

    const exit = this.graph.resolve(step, ctx.defaults).exits.find((e) => e.name === outcome.exit)
    if (!exit) return { output: out }
    const { payload } = outcome
    let paused = exit.report
      ? await this.run(exit.report, payload.report, ctx, `report:${exit.name}`)
      : undefined
    for (const target of exit.targets) {
      paused =
        (await this.run(
          target,
          target.id ? payload[target.id] : undefined,
          ctx,
          `exit:${exit.name}`,
        )) ?? paused
      // Un agente destino al que interrumpieron ya corrió su `onInterrupt`: el resto no corre.
      if (paused || ctx.execution?.interruption) break
    }
    return { output: out, exit: { exit, payload }, ...(paused ? { paused } : {}) }
  }

  /**
   * Corre los miembros de un grupo A LA VEZ y combina su veredicto (`ParallelGroup.until`).
   *
   * Cada miembro corre como un paso más (su `when`/`whenText`, su span) y, si eligió una salida,
   * publica SU reporte — nunca sus destinos: en un grupo la transición es del grupo. Se espera a
   * todos aunque uno falle: los que terminaron ya publicaron, y cortar a los demás a mitad dejaría
   * su trabajo sin reportar.
   *
   * Tira (una vez, para el grupo entero) si un miembro tiró o terminó sin salida (`truncated`,
   * `cancelled`): eso es un error, no un "no pasó" — un corte del provider no puede mandar la
   * tarjeta de vuelta a Build. Interrumpido, devuelve lo que haya y `runDue` corre el
   * `onInterrupt` del grupo una sola vez.
   */
  private async runGroup(
    group: ParallelGroup,
    ctx: PipelineExecutionContext,
  ): Promise<GroupResult> {
    const settled = await Promise.allSettled(
      group.members.map((member) => this.runMember(member, group, { ...ctx, lane: member.id })),
    )
    const interrupted = ctx.execution?.interruption !== undefined
    const { members, progress, failures } = collectMembers(group, settled, interrupted)
    if (interrupted) return { members, ...(progress ? { progress } : {}) }
    if (failures.length > 0) throw new Error(`grupo "${group.id}": ${failures.join('; ')}`)
    const passed = group.verdict(members)
    if (passed === undefined) {
      this.log.warn(`${this.pipelineId}: el grupo "${group.id}" no corrió ningún miembro`)
      return { members }
    }
    return { passed, members }
  }

  /** Un miembro: si su `when` lo deja, corre con su span y publica el reporte de la salida que
   *  eligió. `verdict` ausente = corrió pero no eligió salida. */
  private async runMember(
    member: Runnable,
    group: ParallelGroup,
    ctx: PipelineExecutionContext,
  ): Promise<MemberRun> {
    if (!member.shouldRun(ctx)) return { ran: false }
    const payload = ctx.event.payload
    const subject = typeof payload === 'object' && payload !== null ? payload : {}
    const textMismatch = await member.explainText(subject, ctx.classifier, ctx.event)
    if (textMismatch) {
      this.log.info(`${this.pipelineId}: ${member.id ?? 'paso'} no corre — ${textMismatch}`)
      return { ran: false }
    }
    const run = await this.runMemberDue(member, undefined, ctx, `group:${group.id}`)
    if ('error' in run) throw run.error
    const result = run.output as AgentRunResult | undefined
    const summary = result?.output?.summary
    if (ctx.execution?.interruption) {
      const left = result?.progress ?? summary
      return { ran: true, ...(left ? { progress: left } : {}) }
    }
    if (!run.exit) return { ran: true }
    return { ran: true, verdict: { exit: run.exit.exit.name, ...(summary ? { summary } : {}) } }
  }

  @traced(stepTrace)
  private async runMemberDue(
    member: Runnable,
    _input: unknown,
    ctx: PipelineExecutionContext,
    _via: StepVia,
  ): Promise<StepRun> {
    const out = await member.run(ctx)
    if (member.id) ctx.steps[member.id] = out
    const outcome = member.outcome(out)
    if (outcome.kind === 'pause') {
      throw new Error(`${member.id}: un miembro de un grupo no puede pausar`)
    }
    if (outcome.kind === 'output' || ctx.execution?.interruption) return { output: out }
    const exit = this.graph.resolve(member, ctx.defaults).exits.find((e) => e.name === outcome.exit)
    if (!exit) return { output: out }
    if (exit.report) {
      await this.run(exit.report, outcome.payload.report, ctx, `report:${exit.name}`)
    }
    return { output: out, exit: { exit, payload: outcome.payload } }
  }

  /** Si a `step` lo interrumpieron mientras corría: sólo se interrumpe a un agente en su loop, y
   *  una vez — la que ya dejó su `InterruptionReport` fue la de otro paso. */
  private interruptedIn(step: Runnable, ctx: PipelineExecutionContext): boolean {
    return (
      (step.kind === 'agent' || step.kind === 'group') &&
      ctx.execution?.interruption !== undefined &&
      ctx.steps[INTERRUPTION_STEP] === undefined
    )
  }

  /**
   * En vez de las salidas del agente: deja en `steps.interruption` por qué paró y en qué quedó, y
   * corre el `onInterrupt` de su cascada (sin `onError`: si falla, falla la corrida). La pipeline
   * corta después (`Pipeline.execute`).
   */
  private async interrupt(
    step: Runnable,
    progress: string,
    ctx: PipelineExecutionContext,
  ): Promise<InterruptionReport> {
    const interruption = ctx.execution?.interruption
    if (!interruption) throw new Error(`Pipeline(${this.pipelineId}): no hay interrupción`)
    const report: InterruptionReport = { ...interruption, agent: step.id ?? '', progress }
    ctx.steps[INTERRUPTION_STEP] = report
    const route =
      step.exitRoutes !== undefined ? this.graph.resolve(step, ctx.defaults).onInterrupt : null
    for (const target of routeTargets(route?.route.to)) {
      if (await this.run(target, undefined, ctx, 'onInterrupt', false)) {
        throw new Error(
          `Pipeline(${this.pipelineId}): un \`onInterrupt\` no puede pausar la ejecución`,
        )
      }
    }
    return report
  }

  /** El `onError` que aplica a un paso, y el `report` con el que se anuncia. Un paso que elige
   *  salidas usa su cascada completa; cualquier otro: el suyo > el de la pipeline > el del
   *  proyecto. */
  private errorHandling(
    step: Runnable,
    ctx: PipelineExecutionContext,
  ): { route: ErrorRoute; report: Runnable | null } | null {
    if (step.exitRoutes !== undefined) {
      const resolved = this.graph.resolve(step, ctx.defaults)
      return resolved.onError
        ? { route: resolved.onError.route, report: resolved.report?.target ?? null }
        : null
    }
    const route = firstSet(step.onError, this.defaults.onError, ctx.defaults?.onError)
    if (!route) return null
    return { route, report: firstSet(this.defaults.report, ctx.defaults?.report) ?? null }
  }

  private async runErrorRoute(
    report: Runnable | null,
    route: ErrorRoute,
    error: Error,
    ctx: PipelineExecutionContext,
  ): Promise<void> {
    const reportPaused =
      report && route.report
        ? await this.run(report, route.report(error), ctx, 'onError.report', false)
        : undefined
    for (const target of routeTargets(route.to)) {
      // El `onError` del proyecto recién se conoce al correr: lo que el grafo no pudo validar.
      if ((await this.run(target, route.input?.(error), ctx, 'onError', false)) ?? reportPaused) {
        throw new Error(`Pipeline(${this.pipelineId}): un \`onError\` no puede pausar la ejecución`)
      }
    }
  }
}

/** El primer valor definido, del nivel más específico al más general. `null` corta: "ninguno". */
function firstSet<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== undefined) return value
  }
  return null
}

type MemberRun = { ran: boolean; verdict?: MemberVerdict; progress?: string }

/** Lo que dejó cada miembro: su veredicto, en qué quedó si cedió, y qué falló. Sin salida cuenta
 *  como falla — salvo interrumpido, donde ceder sin salida es lo esperado. */
function collectMembers(
  group: ParallelGroup,
  settled: PromiseSettledResult<MemberRun>[],
  interrupted: boolean,
): {
  members: Record<string, MemberVerdict>
  progress?: Record<string, string>
  failures: string[]
} {
  const members: Record<string, MemberVerdict> = {}
  const progress: Record<string, string> = {}
  const failures: string[] = []
  settled.forEach((result, index) => {
    const id = group.members[index]?.id ?? `#${index}`
    if (result.status === 'rejected') {
      failures.push(`${id}: ${(result.reason as Error)?.message ?? String(result.reason)}`)
      return
    }
    const { ran, verdict, progress: left } = result.value
    if (!ran) return
    if (verdict) members[id] = verdict
    if (left) progress[id] = left
    if (!verdict && !interrupted) failures.push(`${id}: terminó sin elegir salida`)
  })
  return { members, ...(Object.keys(progress).length > 0 ? { progress } : {}), failures }
}

/** En qué quedó un paso interrumpido: lo que entregó un agente en `yield_turn` (o su resumen), o
 *  lo de cada miembro de un grupo. */
function progressOf(step: Runnable, out: unknown): string {
  if (step.members) {
    const group = out as GroupResult | undefined
    const left = {
      ...Object.fromEntries(
        Object.entries(group?.members ?? {}).map(([id, v]) => [id, v.summary ?? v.exit]),
      ),
      ...group?.progress,
    }
    return Object.entries(left)
      .map(([id, text]) => `${id}: ${text}`)
      .join('\n')
  }
  const { output, progress } = out as AgentRunResult
  return progress ?? output.summary ?? ''
}
