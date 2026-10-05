/**
 * La config cargada, en corto y de sólo lectura: qué escucha cada pipeline, con qué condiciones,
 * qué agentes y acciones corre, y a dónde lleva cada salida de sus agentes. Es lo que el asistente
 * lee para explicar "por qué pasó esto" sin abrir los YAML.
 */
import {
  END,
  isAgent,
  type Pipeline,
  type ResolvedRoutes,
  type Runnable,
  withMembers,
} from '@ia-flow/agent-engine'
import type { ConfigSummary, InboxProject } from '@ia-flow/shared'

export interface ConfigSource {
  projects: InboxProject[]
  /** `providers:` de runner.yaml: de cada uno sale sólo lo que `providerSummary` deja pasar. */
  providers?: Record<string, Record<string, unknown>>
  /** `mcp:` de runner.yaml: de cada uno, su id y el host de su URL. */
  mcp?: Array<{ id: string; config: { url?: string } }>
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
  // Sólo los ids de los pasos: serializar el `ErrorRoute` vuelca las acciones vivas con su cliente
  // (y el `auth` de GitHub: privateKey, token) a una respuesta que lee la web.
  if (routes.onError) {
    const steps = [routes.onError.route.to ?? []].flat().filter((target) => target !== END)
    out.onError = steps.map((target) => stepId(target as Runnable)).join(' → ') || '(nada)'
  }
  return out
}

/** Un provider sin nada que pueda ser un secreto: una lista de claves permitidas, no una de
 *  prohibidas (un campo nuevo con un token no se cuela solo). Sin `type`, el de Anthropic. */
function providerSummary(id: string, config: Record<string, unknown>) {
  const text = (key: string) =>
    typeof config[key] === 'string' ? (config[key] as string) : undefined
  const max = config.maxConcurrent
  return {
    id,
    type: text('type') ?? 'anthropic-api',
    ...(text('mode') ? { mode: text('mode') } : {}),
    ...(text('provider') ? { provider: text('provider') } : {}),
    ...(typeof max === 'number' ? { max_concurrent: max } : {}),
  }
}

/** El host de la URL de un MCP; sin URL armable (una variable sin resolver), que viene del env. */
function mcpHost(url: string | undefined): string {
  try {
    return url ? new URL(url).host : '—'
  } catch {
    return 'del ambiente'
  }
}

export function configSummary(source: ConfigSource): ConfigSummary {
  const agents = new Map<string, ConfigSummary['agents'][number]>()
  const pipelines = source.pipelines().map(({ pipeline, sourceId }) => {
    // Los miembros de un grupo `parallel` son agentes de la pipeline como cualquier otro.
    const steps = pipeline.do.flatMap(withMembers)
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
  return {
    projects: source.projects,
    pipelines,
    agents: [...agents.values()],
    providers: Object.entries(source.providers ?? {}).map(([id, config]) =>
      providerSummary(id, config),
    ),
    mcp: (source.mcp ?? []).map((entry) => ({ id: entry.id, host: mcpHost(entry.config.url) })),
  }
}
