import { matchScope } from '@ia-flow/rules'
import type {
  AgentDefinition,
  Pipeline,
  PipelineWait,
  Rule,
  RunningAgent,
  Vocabulary,
} from '@ia-flow/shared'
import type { IRuleRepository } from '../../domain/ports/IRuleRepository.js'
import type { IWaitRepository } from '../../domain/ports/IWaitRepository.js'

/** Lo que el use-case necesita saber de un run en vuelo. Angosto a propósito:
 *  el registry tiene 20 campos y acá se usan seis. */
export interface PipelineRunSnapshot {
  taskId: string
  taskTitle?: string
  issueNumber?: number
  agentId?: string
  ruleId?: string
  runId?: string
  executionId?: string
  status: string
  projectId?: string
  parentRunId?: string
}

export interface GetPipelineDeps {
  /** Runs en vuelo, de todo el proceso. El filtrado por proyecto lo hace este
   *  use-case: es la misma pregunta que ya contesta el cap del proyecto. */
  runningAgents(): PipelineRunSnapshot[]
  /** Los agentes visibles en el ámbito — propios más globales. */
  agentsFor(projectId?: string): Promise<AgentDefinition[]>
  /** Los statuses que la fuente reporta para el proyecto. Puede fallar —la
   *  fuente es una llamada de red— y este use-case decide qué significa eso. */
  statusesFor(projectId?: string): Promise<string[]>
  /** Los repos registrados en el proyecto. */
  reposFor(projectId?: string): Promise<string[]>
}

/** Los nombres de agente que una regla nombra en su `do[]`. */
function agentsNamedBy(rule: Rule): string[] {
  return (rule.do ?? [])
    .filter((a) => a.action === 'agent')
    .map((a) => (a as { agentId?: string }).agentId)
    .filter((id): id is string => Boolean(id))
}

/**
 * Sobre qué statuses dispara una regla.
 *
 * Sale de sus condiciones `when` sobre el campo `status`, que es como el status
 * dejó de ser una tabla y pasó a ser una condición más (migración 059). Una
 * regla sin ninguna condición de status dispara sobre **todos**, así que
 * "cubre" a cualquiera — es lo que evita reportar como huérfano un status que
 * en realidad tiene una regla global encima.
 */
function statusesCoveredBy(rule: Rule): { all: boolean; names: string[] } {
  const conds = Array.isArray(rule.when) ? rule.when : []
  const names = conds
    .filter((c) => c.field === 'status' && (c.op === '=' || c.op === undefined))
    .map((c) => String(c.value ?? '').toLowerCase())
    .filter(Boolean)
  return { all: names.length === 0, names }
}

/**
 * Lo configurado y lo que corre encima, en una sola respuesta.
 *
 * Son una sola pregunta —“¿qué hace este proyecto y qué está haciendo ahora?”—
 * y partirla en dos requests obligaría a la UI a correlacionar dos snapshots
 * tomados en momentos distintos: un run que arranca entre los dos aparecería
 * colgado de una regla que la primera respuesta no traía.
 */
export class GetPipelineUseCase {
  constructor(
    private readonly rules: IRuleRepository,
    private readonly waits: IWaitRepository,
    private readonly deps: GetPipelineDeps,
  ) {}

  async execute(projectId?: string): Promise<Pipeline> {
    const rules = await this.rules.visibleTo(projectId)

    const running: RunningAgent[] = this.deps
      .runningAgents()
      .filter((r) => !projectId || !r.projectId || r.projectId === projectId)
      .map((r) => ({
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        issueNumber: r.issueNumber,
        agentId: r.agentId,
        ruleId: r.ruleId,
        runId: r.runId,
        executionId: r.executionId,
        status: r.status,
        isSubAgent: Boolean(r.parentRunId),
      }))

    // Las esperas son por proyecto y no cruzan ámbito: una espera global no
    // existe — siempre cuelga de una task, que siempre tiene proyecto.
    const waits: PipelineWait[] = projectId
      ? (await this.waits.listByProject(projectId)).map((w) => ({
          id: w.id,
          taskId: w.taskId,
          agentId: w.agentId,
          on: w.on,
          expiresAt: w.expiresAt,
          isPause: w.checkpoint != null,
        }))
      : []

    // Statuses y agentes se piden UNA vez y sirven a dos consumidores: el
    // cálculo de huecos y el autocomplete. Pedirlos dos veces sería un
    // round-trip de más a la fuente por cada carga de la pantalla.
    //
    // No poder LEER los statuses no es lo mismo que no tener ninguno: si la
    // fuente está caída, reportar todos como huecos sería un aviso ruidoso
    // apuntando al lugar equivocado. Sin lista, sin aviso.
    const statuses = await this.deps.statusesFor(projectId).catch(() => [])
    const agents = await this.deps.agentsFor(projectId)

    return {
      rules,
      running,
      waits,
      gaps: this.gaps(rules, agents, statuses, projectId),
      vocabulary: {
        agentIds: agents.map((a) => a.id).sort(),
        statuses,
        repos: await this.deps.reposFor(projectId).catch(() => []),
      } satisfies Vocabulary,
    }
  }

  /**
   * Los huecos se DERIVAN, nunca se declaran.
   *
   * Sólo cuentan las reglas habilitadas: una deshabilitada no corre, así que un
   * agente que sólo ella nombra tampoco. Reportarlo como usado escondería
   * exactamente el caso que este aviso existe para mostrar.
   */
  private gaps(
    rules: Rule[],
    agents: AgentDefinition[],
    statuses: string[],
    projectId?: string,
  ): Pipeline['gaps'] {
    const enabled = rules.filter((r) => r.enabled !== false)

    const named = new Set(enabled.flatMap(agentsNamedBy))
    const unusedAgents = agents
      .filter((a) => !named.has(a.id))
      // Un agente global visible desde un proyecto puede estar usado por una
      // regla de OTRO proyecto; marcarlo como sin usar acá sería falso.
      .filter((a) => !projectId || a.projectId != null)
      .map((a) => a.id)

    const scoped = enabled.filter((r) =>
      matchScope({ projectId: r.projectId ?? null, repoName: null }, { projectId }),
    )
    const coversEverything = scoped.some((r) => statusesCoveredBy(r).all)
    const covered = new Set(scoped.flatMap((r) => statusesCoveredBy(r).names))
    const statusesWithoutRules = coversEverything
      ? []
      : statuses.filter((s) => !covered.has(s.toLowerCase()))

    return { unusedAgents, statusesWithoutRules }
  }
}
