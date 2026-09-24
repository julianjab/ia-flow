import { Agent, type AgentExit } from '../../engine/Agent.js'
import { AgentRunEntity } from '../../engine/AgentRunEntity.js'
import { Execution, type ExecutionMessage } from '../../engine/Execution.js'
import type { WorkspaceRequest } from '../../engine/Workspace.js'
import { Project } from '../../domain/Project.js'
import { Repo } from '../../domain/Repo.js'
import {
  PipelineActionEntry,
  type PipelineActionEntryProps,
  type PipelineExecutionContext,
} from './PipelineActionEntry.js'

export interface AgentActionProps extends PipelineActionEntryProps {
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
export class AgentAction extends PipelineActionEntry {
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

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    const taskId = ctx.event.scope?.issueId

    if (this.liveInject) {
      const message: ExecutionMessage = {
        body: this.brief ?? JSON.stringify(ctx.event.payload),
        origin: ctx.event.type,
        occurredAt: ctx.event.occurredAt,
        payload: ctx.event.payload,
      }
      if (Execution.tryAppend(taskId, message)) {
        return { kind: 'live-injected' }
      }
    }

    const agent = Agent.resolve(this.agentId)
    if (agent == null) throw new Error(`AgentAction: agente desconocido "${this.agentId}"`)

    const project =
      ctx.event.scope?.projectId != null ? Project.resolve(ctx.event.scope.projectId) : undefined
    if (
      project != null &&
      !Execution.withinCap(
        Execution.runningForProject(project.id),
        project.settings.maxConcurrentDispatches,
      )
    ) {
      return { kind: 'deferred', reason: 'cap de proyecto' }
    }
    if (!Execution.withinCap(Execution.runningForAgent(agent.id), agent.maxConcurrentDispatches)) {
      return { kind: 'deferred', reason: 'cap de agente' }
    }

    const execution = new Execution({
      id: crypto.randomUUID(),
      pipelineId: ctx.pipelineId,
      doId: this.id ?? crypto.randomUUID(),
      taskId,
      kind: 'agent',
      entity: new AgentRunEntity(),
      agentId: agent.id,
      projectId: project?.id,
    })

    try {
      const output = await agent.run({
        payload: ctx.event.payload,
        brief: this.brief,
        expectedOutput: ctx.nextSchema,
        workspace: this.buildWorkspaceRequest(ctx, execution.id, agent, project),
      })
      execution.complete()
      if (this.emitOn === 'exit') {
        ctx.bus.publish(
          ctx.event.derive(this.emitType ?? 'run.finished', {
            agentId: agent.id,
            taskId,
            outcome: output.outcome,
            exit: output.exit != null ? JSON.stringify(output.exit) : undefined,
          }),
        )
      }
      return output
    } catch (err) {
      execution.fail()
      throw err
    }
  }

  /**
   * Ausente cuando el agente no declara `requiresBranch` — construirlo igual
   * sería trabajo tirado, `Agent.execute()` lo ignora salvo que lo necesite.
   * `taskId` cae a `execution.id` cuando el evento no trae `scope.issueId`
   * (un normalizador sin issue asociado): `WorkspaceRequest.taskId` es
   * obligatorio porque un Provider lo usa para nombrar el worktree, y
   * cualquier string estable sirve para eso.
   */
  private buildWorkspaceRequest(
    ctx: PipelineExecutionContext,
    executionId: string,
    agent: Agent,
    project?: Project,
  ): WorkspaceRequest | undefined {
    if (!agent.requiresBranch) return undefined
    const repoNames = ctx.event.scope?.repos ?? []
    return {
      taskId: ctx.event.scope?.issueId ?? executionId,
      repos: repoNames.map((name) => ({
        name,
        path: project != null ? Repo.resolve(project.id, name)?.path : undefined,
      })),
      needsWrite: agent.hasWriteTools(),
    }
  }
}
