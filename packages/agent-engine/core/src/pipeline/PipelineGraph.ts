import {
  type ExitDefaults,
  type ExitRoutes,
  type ResolvedRoutes,
  resolveRoutes,
  routeTargets,
  submitSchemaFor,
} from '../routing/ExitRoutes.js'
import type { Resumable, Runnable } from './Runnable.js'

export interface PipelineGraphProps {
  pipelineId: string
  do: Runnable[]
  defaults: ExitDefaults
  /** Overrides de rutas por paso que elige salidas (clave: su `id`). */
  stepRoutes: Record<string, ExitRoutes>
}

/**
 * El grafo de una pipeline, analizado UNA vez al construirla: qué pasos eligen salidas (agentes),
 * qué pausas se alcanzan, qué pasos sólo corren como destino de una ruta, y que todo el cableado
 * sea válido (salidas con destino, overrides que existen, sin ciclos entre agentes, pausas que se
 * pueden reanudar).
 *
 * Pregunta a cada paso por lo que sabe hacer (`exitRoutes`, `asResumable`), no por su clase: un
 * tipo de paso nuevo que elige salidas o pausa entra sin tocar esto.
 */
export class PipelineGraph {
  private readonly pipelineId: string
  private readonly steps: Runnable[]
  private readonly defaults: ExitDefaults
  private readonly stepRoutes: Record<string, ExitRoutes>
  /** Los pasos que eligen salidas, de `do[]` y de las rutas de la pipeline, por id. */
  private readonly agents: Map<string, Runnable>
  /** Las pausas de `do[]` y de los destinos de las salidas (y de sus ramas), por id. */
  private readonly pauses: Map<string, Resumable>
  /** Los pasos que sólo corren como destino de una ruta: `do[]` los saltea. */
  readonly routed: Set<Runnable>

  constructor(props: PipelineGraphProps) {
    this.pipelineId = props.pipelineId
    this.steps = props.do
    this.defaults = props.defaults
    this.stepRoutes = props.stepRoutes
    this.agents = this.findAgents()
    this.routed = this.validate()
    this.pauses = this.findPauses()
  }

  /** Si cada corrida tiene que ser una ejecución: corre agentes, o puede pausarse (una pausa
   *  sólo existe dentro de una ejecución). */
  get needsExecution(): boolean {
    return this.agents.size > 0 || this.pauses.size > 0
  }

  /** Las rutas efectivas de un paso que elige salidas, en esta pipeline. Con `project`, incluye
   *  los defaults del proyecto — lo que efectivamente va a correr. */
  resolve(step: Runnable, project?: ExitDefaults): ResolvedRoutes {
    return resolveRoutes(step.id as string, step.exitRoutes ?? {}, {
      project,
      pipeline: this.defaults,
      step: this.stepRoutes[step.id as string],
    })
  }

  /** Las rutas efectivas del agente `agentId` en esta pipeline. */
  routesOf(agentId: string, project?: ExitDefaults): ResolvedRoutes {
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new Error(`Pipeline(${this.pipelineId}): no corre ningún agente "${agentId}"`)
    }
    return this.resolve(agent, project)
  }

  /** La pausa con ese id, en `do[]` o como destino de alguna salida. */
  pause(pauseId: string): Resumable {
    const pause = this.pauses.get(pauseId)
    if (!pause) throw new Error(`Pipeline(${this.pipelineId}): no hay una pausa "${pauseId}"`)
    return pause
  }

  private findAgents(): Map<string, Runnable> {
    const agents = new Map<string, Runnable>()
    const visit = (step: Runnable) => {
      if (step.exitRoutes === undefined) return
      const existing = agents.get(step.id as string)
      if (existing === step) return
      if (existing) {
        throw new Error(
          `Pipeline(${this.pipelineId}): dos agentes distintos con el id "${step.id}"`,
        )
      }
      agents.set(step.id as string, step)
      for (const route of Object.values(this.stepRoutes[step.id as string]?.routes ?? {})) {
        for (const target of routeTargets(route?.to)) visit(target)
      }
    }
    for (const step of this.steps) visit(step)
    return agents
  }

  private findPauses(): Map<string, Resumable> {
    const pauses = new Map<string, Resumable>()
    const seen = new Set<Runnable>()
    const walk = (steps: Runnable[]) => {
      for (const step of steps) {
        if (seen.has(step)) continue
        seen.add(step)
        const pause = step.asResumable()
        if (pause) {
          pauses.set(pause.id, pause)
          walk(pause.allTargets)
        } else if (step.exitRoutes !== undefined) {
          walk(this.resolve(step).exits.flatMap((exit) => exit.targets))
        }
      }
    }
    walk([...this.steps])
    return pauses
  }

  private validate(): Set<Runnable> {
    for (const agentId of Object.keys(this.stepRoutes)) {
      if (!this.agents.has(agentId)) {
        throw new Error(
          `Pipeline(${this.pipelineId}): routes.${agentId} sobrescribe un agente que la pipeline no corre`,
        )
      }
    }

    const routed = new Set<Runnable>()
    const next = new Map<Runnable, Runnable[]>()
    for (const agent of this.agents.values()) {
      const resolved = this.resolve(agent)
      const children: Runnable[] = []
      for (const exit of resolved.exits) {
        submitSchemaFor(agent.id as string, exit)
        for (const target of exit.targets) {
          routed.add(target)
          if (target.exitRoutes !== undefined) children.push(target)
        }
        if (exit.report) routed.add(exit.report)
      }
      for (const target of routeTargets(resolved.onError?.route.to)) routed.add(target)
      next.set(agent, children)
    }
    for (const step of this.steps) {
      for (const target of routeTargets(step.onError?.to)) routed.add(target)
    }
    for (const target of routeTargets(this.defaults.onError?.to)) routed.add(target)
    this.assertNoCycles(next)
    this.assertPausesResumable()
    return routed
  }

  /**
   * Una pausa se reanuda desde su `Checkpoint`, que sabe seguir `do[]` pero no una lista de
   * destinos a medias ni un `onError`. Por eso, al construir: lo que puede pausar (una pausa, o un
   * agente que llega a una por sus salidas) va ÚLTIMO en su lista de destinos — si no, lo que viene
   * después se perdería sin error —, y nunca en un `onError`.
   */
  private assertPausesResumable(): void {
    const known = new Map<Runnable, boolean>()
    const canPause = (step: Runnable): boolean => {
      const cached = known.get(step)
      if (cached !== undefined) return cached
      known.set(step, false)
      const result =
        step.asResumable() !== undefined ||
        (step.exitRoutes !== undefined &&
          this.resolve(step).exits.some((exit) => exit.targets.some(canPause)))
      known.set(step, result)
      return result
    }
    const name = (step: Runnable) => step.id ?? step.constructor.name
    const assertLast = (targets: Runnable[], where: string) => {
      targets.forEach((target, index) => {
        if (index < targets.length - 1 && canPause(target)) {
          throw new Error(
            `Pipeline(${this.pipelineId}): ${where}: "${name(target)}" puede pausar y no es el último destino — lo que sigue no se reanudaría`,
          )
        }
      })
    }
    const assertNoPause = (targets: Runnable[], where: string) => {
      for (const target of targets) {
        if (canPause(target)) {
          throw new Error(
            `Pipeline(${this.pipelineId}): ${where}: un \`onError\` no puede pausar ("${name(target)}")`,
          )
        }
      }
    }

    const checked = new Set<Resumable>()
    const checkPause = (step: Runnable) => {
      const pause = step.asResumable()
      if (!pause || checked.has(pause)) return
      checked.add(pause)
      for (const target of pause.allTargets) checkPause(target)
    }
    for (const agent of this.agents.values()) {
      const resolved = this.resolve(agent)
      for (const exit of resolved.exits) {
        assertLast(exit.targets, `${agent.id}.${exit.name}`)
        for (const target of exit.targets) checkPause(target)
      }
      assertNoPause(routeTargets(resolved.onError?.route.to), `${agent.id}.onError`)
    }
    for (const step of this.steps) {
      assertNoPause(routeTargets(step.onError?.to), `${step.id ?? 'paso'}.onError`)
      checkPause(step)
    }
    assertNoPause(routeTargets(this.defaults.onError?.to), 'onError')
    for (const pause of checked) {
      for (const branch of pause.branchNames) {
        assertLast(pause.targetsOf(branch), `${pause.id}.${branch}`)
      }
    }
  }

  private assertNoCycles(next: Map<Runnable, Runnable[]>): void {
    const done = new Set<Runnable>()
    const visiting: Runnable[] = []
    const walk = (agent: Runnable) => {
      if (done.has(agent)) return
      const at = visiting.indexOf(agent)
      if (at !== -1) {
        const cycle = [...visiting.slice(at), agent].map((a) => a.id).join(' → ')
        throw new Error(
          `Pipeline(${this.pipelineId}): ciclo entre agentes (${cycle}) — un loop pasa por un evento, no por una ruta`,
        )
      }
      visiting.push(agent)
      for (const child of next.get(agent) ?? []) walk(child)
      visiting.pop()
      done.add(agent)
    }
    for (const agent of next.keys()) walk(agent)
  }
}
