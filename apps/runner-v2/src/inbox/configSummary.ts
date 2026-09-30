/**
 * La config cargada, en corto y de sólo lectura: qué escucha cada pipeline, con qué condiciones,
 * qué agentes y acciones corre, y a dónde lleva cada salida de sus agentes. Es lo que el asistente
 * lee para explicar "por qué pasó esto" sin abrir los YAML.
 */
import { isAgent, type Pipeline, type ResolvedRoutes } from '@ia-flow/agent-engine'
import type { ConfigSummary, InboxProject } from '@ia-flow/shared'

export interface ConfigSource {
  projects: InboxProject[]
  /** Cada pipeline con el id de su fuente (la global `runner` o un proyecto). */
  pipelines(): Array<{ pipeline: Pipeline; sourceId: string }>
  routesOf(pipeline: Pipeline, agentId: string): ResolvedRoutes
}

const stepId = (step: { id?: string; constructor: { name: string } }) =>
  step.id ?? step.constructor.name

/** Una condición como se escribe en el YAML: `item.status eq "Refine"`. */
function conditionText(condition: { field: string; op: string; value?: unknown; logic: string }) {
  const value = condition.value === undefined ? '' : ` ${JSON.stringify(condition.value)}`
  return `${condition.logic === 'or' ? 'o ' : ''}${condition.field} ${condition.op}${value}`
}

function routeText(routes: ResolvedRoutes): Record<string, string> {
  const out: Record<string, string> = {}
  for (const exit of routes.exits) {
    out[exit.name] = exit.targets.map((target) => stepId(target)).join(' → ') || '(nada)'
  }
  if (routes.onError) out.onError = JSON.stringify(routes.onError.route)
  return out
}

export function configSummary(source: ConfigSource): ConfigSummary {
  const agents = new Map<string, ConfigSummary['agents'][number]>()
  const pipelines = source.pipelines().map(({ pipeline, sourceId }) => {
    const steps = pipeline.do
    for (const step of steps.filter(isAgent)) {
      const id = stepId(step)
      if (agents.has(id)) continue
      agents.set(id, {
        id,
        providers: step.candidates.map((candidate) => candidate.id),
        routes: routeText(source.routesOf(pipeline, id)),
      })
    }
    return {
      id: pipeline.id,
      source_id: sourceId,
      on: pipeline.on,
      when: pipeline.trigger.when.map(conditionText),
      exclusive: pipeline.exclusive,
      position: pipeline.position,
      agents: steps.filter(isAgent).map(stepId),
      actions: steps.filter((step) => !isAgent(step)).map(stepId),
    }
  })
  return { projects: source.projects, pipelines, agents: [...agents.values()] }
}
