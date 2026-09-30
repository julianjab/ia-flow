/**
 * Qué deja una pipeline en la traza — lo usan los decorators de `Pipeline` y `StepRunner`, así
 * correr los pasos no mezcla spans con la lógica.
 */
import { type Attributes, markError, type TraceOptions, truncate } from '@ia-flow/telemetry'
import type { Agent, AgentRunResult } from '../agent/Agent.js'
import { SCOPE } from '../engine/tracing.js'
import { isAgent, type Pipeline, type StepRun, type StepVia } from './Pipeline.js'
import type { PipelineExecutionContext, Runnable } from './Runnable.js'
import type { StepRunner } from './StepRunner.js'

type StepArgs = [Runnable, unknown, PipelineExecutionContext, StepVia, boolean?]

const stepName = (step: Runnable) => step.id ?? step.constructor.name

/** Con qué corre un agente: provider, tools configuradas (sin las `submit_*`) y MCP servers. */
function agentAttributes({ definition: def, toolset, candidates }: Agent): Attributes {
  return {
    'ia.agent.providers': candidates.map((candidate) => candidate.id),
    'ia.agent.tools': toolset.names,
    'ia.agent.mcp_servers': (def.mcpServers ?? []).map((server) => server.id),
  }
}

/** `pipeline <id>`: cuelga del evento; todo lo de adentro hereda `ia.pipeline.id`. */
export const pipelineTrace: TraceOptions<
  Pipeline,
  [PipelineExecutionContext],
  Record<string, unknown>
> = {
  name() {
    return `pipeline ${this.id}`
  },
  scope: SCOPE,
  // `ia.execution.id` también se hereda: cada span y log de la corrida (el provider, una tool)
  // dice de qué ejecución es.
  inherit(ctx) {
    return {
      'ia.pipeline.id': this.id,
      ...(ctx.execution ? { 'ia.execution.id': ctx.execution.id } : {}),
    }
  },
  attributes: (ctx) =>
    ctx.execution?.waitedMs === undefined ? {} : { 'ia.execution.wait_ms': ctx.execution.waitedMs },
}

/**
 * `agent <id>` / `action <id>` por cada paso que corre. Los spans y logs de adentro (el request al
 * modelo, una tool, los destinos de la salida elegida) heredan de qué paso —y de qué agente—
 * vienen. Un error cubierto por un `onError` o `continueOnError` igual deja el paso en ERROR.
 */
export const stepTrace: TraceOptions<StepRunner, StepArgs, StepRun> = {
  name: (step) => `${step.kind} ${stepName(step)}`,
  scope: SCOPE,
  inherit: (step) => ({
    'ia.step.id': stepName(step),
    ...(isAgent(step) ? { 'ia.agent.id': stepName(step) } : {}),
  }),
  attributes: (step, input, _ctx, via) => ({
    'ia.step.id': stepName(step),
    'ia.step.kind': step.kind,
    'ia.step.via': via,
    ...(input === undefined ? {} : { 'ia.step.input': truncate(input) }),
    ...(isAgent(step) ? agentAttributes(step) : {}),
  }),
  onResult(span, run, step) {
    const name = stepName(step)
    if ('error' in run) {
      markError(span, run.error)
      span.setAttribute('ia.step.error_handled', run.handledBy)
      this.log.error(`paso "${name}" falló: ${run.error.message}`)
      return
    }
    if (run.interrupted) {
      span.setAttributes({
        'ia.agent.interrupted_by': run.interrupted.by,
        'ia.agent.progress': truncate(run.interrupted.progress),
      })
      this.log.info(`agente "${name}" cedió su turno: ${run.interrupted.reason}`)
      return
    }
    if (!isAgent(step)) {
      if (run.output !== undefined) span.setAttribute('ia.step.output', truncate(run.output))
      return
    }
    // Un agente que pausó su turno esperando un evento (`wait_for_event`): no eligió salida.
    if (run.paused && !run.exit) {
      span.setAttribute('ia.agent.waiting', run.paused.describe())
      this.log.info(`agente "${name}" espera: ${run.paused.describe()}`)
      return
    }
    const { output } = run.output as AgentRunResult
    span.setAttributes({
      'ia.agent.outcome': output.outcome,
      ...(output.summary ? { 'ia.agent.summary': truncate(output.summary) } : {}),
    })
    if (!run.exit) {
      this.log.warn(`agente "${name}" terminó sin salida (${output.outcome})`)
      return
    }
    const { exit, payload } = run.exit
    const targets = exit.targets.map(stepName)
    span.setAttributes({ 'ia.agent.exit': exit.name, 'ia.agent.exit_origin': exit.origin })
    span.addEvent('route', {
      'ia.route.exit': exit.name,
      'ia.route.targets': targets,
      ...(exit.report ? { 'ia.route.report': exit.report.id ?? 'report' } : {}),
      'ia.route.payload': truncate(payload),
    })
    this.log.info(`agente "${name}" eligió "${exit.name}" → ${targets.join(' → ') || 'fin'}`, {
      'ia.agent.exit': exit.name,
    })
  },
}
