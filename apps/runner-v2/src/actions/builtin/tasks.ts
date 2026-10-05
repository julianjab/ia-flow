/**
 * Las actions que le piden algo al runner sobre una task, no a GitHub: relanzarla, volver a correr
 * su review, pedirle al agente que pare o darle una ronda nueva de corridas (`reset_runs`). Sólo las usa una `taskActions` de `project.yaml` (una persona las pide desde la
 * bandeja); el issue sale del evento y `actor` es quien las pidió.
 */
import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { z } from 'zod'
import type { TaskDesk } from '../../inbox/TaskDesk.js'
import { defineAction } from '../defineAction.js'

function taskOf(ctx: PipelineExecutionContext): { ref: string; actor: string } {
  const payload = (ctx.event.payload ?? {}) as Record<string, unknown>
  const { owner, repo, number, actor } = payload
  if (typeof owner !== 'string' || typeof repo !== 'string' || typeof number !== 'number') {
    throw new Error('el evento no trae owner/repo/number: sólo se puede pedir desde la bandeja')
  }
  return { ref: `${owner}/${repo}#${number}`, actor: typeof actor === 'string' ? actor : 'runner' }
}

class TaskDeskAction extends Action<z.ZodObject<{}>> {
  readonly input = z.strictObject({})
  constructor(
    id: string,
    readonly description: string,
    private readonly run_: (desk: TaskDesk, ref: string, by: string) => Promise<string>,
    private readonly desk: TaskDesk,
  ) {
    super({ id })
  }

  execute(_input: object, ctx: PipelineExecutionContext): Promise<string> {
    const { ref, actor } = taskOf(ctx)
    return this.run_(this.desk, ref, actor)
  }
}

export default [
  defineAction({
    id: 'redispatch_task',
    create: (ctx) =>
      new TaskDeskAction(
        'redispatch_task',
        'Vuelve a despachar el último evento de la task: la corrida arranca de nuevo.',
        (desk, ref, by) => desk.redispatch(ref, by),
        ctx.services.tasks,
      ),
  }),
  defineAction({
    id: 'stop_agent',
    create: (ctx) =>
      new TaskDeskAction(
        'stop_agent',
        'Le pide al agente que corre para la task que termine su turno con lo que tenga.',
        async (desk, ref, by) => desk.stop(ref, by),
        ctx.services.tasks,
      ),
  }),
  defineAction({
    id: 'reset_runs',
    create: (ctx) =>
      new TaskDeskAction(
        'reset_runs',
        'Pone en cero los topes de corridas (`maxRuns`) de la task: le da una ronda nueva.',
        async (desk, ref, by) => desk.resetRuns(ref, by),
        ctx.services.tasks,
      ),
  }),
  defineAction({
    id: 'rerun_review',
    create: (ctx) =>
      new TaskDeskAction(
        'rerun_review',
        'Vuelve a correr el reviewer, como si la card acabara de llegar a Review.',
        (desk, ref, by) => desk.rerunReview(ref, by),
        ctx.services.tasks,
      ),
  }),
]
