import type { AgentExit } from '../../engine/Agent.js'
import {
  RuleActionEntry,
  type RuleActionEntryProps,
  type RuleExecutionContext,
} from './RuleActionEntry.js'

export interface AgentActionProps extends RuleActionEntryProps {
  agentId: string
  /** Publica el resultado del run como DomainEvent — convierte al agente en
   *  normalizador (ej. un triage sin issue asociado). */
  emitOn?: 'exit'
  /** Tipo del evento derivado. Ausente ⇒ 'run.finished'. */
  emitType?: string
  /** Por qué corre el agente ESTA vez — antepuesto al prompt, admite {{event.*}}. */
  brief?: string
  /** Override del `exits` del agente para ESTE disparo (merge por clave, sólo
   *  sobre claves que el agente ya declara). */
  exitsOverride?: Record<string, AgentExit>
  /** Agentes válidos cuando agentId sale de un paso anterior (template). */
  allowAgents?: string[]
  /** Si hay un run en vuelo sobre la misma task, inyecta el brief ahí en vez de diferir. */
  liveInject?: boolean
}

/** Correr un agente — envuelve lo que hace AgentOrchestrator.runAgent en v1. */
export class AgentAction extends RuleActionEntry {
  readonly kind = 'agent' as const
  readonly agentId: string
  readonly emitOn?: 'exit'
  readonly emitType?: string
  readonly brief?: string
  readonly exitsOverride?: Record<string, AgentExit>
  readonly allowAgents: string[]
  readonly liveInject: boolean

  constructor(props: AgentActionProps) {
    super(props)
    this.agentId = props.agentId
    this.emitOn = props.emitOn
    this.emitType = props.emitType
    this.brief = props.brief
    this.exitsOverride = props.exitsOverride
    this.allowAgents = props.allowAgents ?? []
    this.liveInject = props.liveInject ?? false
  }

  async run(ctx: RuleExecutionContext): Promise<unknown> {
    throw new Error(
      'not implemented — si this.liveInject && Execution.tryAppend(ctx.task?.id, toMessage(ctx.event)) ' +
        'devolver ese resultado sin correr un run nuevo; si no: const agent = Agent.resolve(this.agentId); ' +
        'const project = ctx.task?.projectId ? Project.resolve(ctx.task.projectId) : undefined; ' +
        'if (project && !PendingTask.withinCap(PendingTask.runningForProject(project.id), ' +
        'project.settings.maxConcurrentDispatches)) return { kind: "deferred", reason: "cap de proyecto" }; ' +
        'if (!PendingTask.withinCap(PendingTask.runningForAgent(agent.id), agent.maxConcurrentDispatches)) ' +
        'return { kind: "deferred", reason: "cap de agente" }; ' +
        'PendingTask.register(new PendingTask({taskId: ctx.task.id, projectId: project?.id, agentId: agent.id})); ' +
        'new Execution({pipelineId, doId: this.id, taskId: ctx.task?.id, kind: "agent", ' +
        'entity: new AgentRunEntity()}) ANTES de arrancar (se autoindexa en su constructor); ' +
        'try { agent.run({task: ctx.task, brief: this.brief, expectedOutput: ctx.nextSchema}); ' +
        'execution.complete() } catch { execution.fail() } finally { PendingTask.remove(ctx.task.id) }; ' +
        'si emitOn=="exit" ctx.bus.publish(ctx.event.derive(this.emitType ?? "run.finished", {...}))',
    )
  }
}
