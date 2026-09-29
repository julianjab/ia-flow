import type { Pause } from './actions/Pause.js'
import type { Resumption } from './Pipeline.js'
import type { PipelineGraph } from './PipelineGraph.js'
import type { PipelineExecutionContext, Runnable } from './Runnable.js'

/**
 * Por dónde sigue una pipeline pausada: guardar el `Checkpoint` en la ejecución al pausarse, y al
 * reanudar comprobar que la pipeline no cambió y decir qué corre por la rama que la despertó.
 */
export class Checkpoints {
  constructor(
    private readonly pipelineId: string,
    private readonly steps: Runnable[],
    private readonly graph: PipelineGraph,
  ) {}

  /** La forma de `do[]` que guarda un `Checkpoint`. */
  get shape(): string {
    return this.steps.map((step) => step.id ?? step.constructor.name).join(' → ')
  }

  /** Un paso devolvió una pausa: la pipeline se corta acá y la ejecución guarda por dónde seguir. */
  save(ctx: PipelineExecutionContext, pause: Pause, resumeAt: number): Record<string, unknown> {
    if (!ctx.execution) {
      // Sin ejecución propia no hay qué pausar: un Engine sin `executions`, o una pipeline que
      // corre anidada dentro de otra ejecución (un evento que emitió esa misma ejecución).
      throw new Error(
        `Pipeline(${this.pipelineId}): la pausa "${pause.pauseId}" necesita correr como su propia ejecución (Engine con \`executions\`, y no anidada en otra)`,
      )
    }
    ctx.execution.pause(pause, {
      pipelineId: this.pipelineId,
      pauseId: pause.pauseId,
      resumeAt,
      steps: ctx.steps,
      shape: this.shape,
      ...(ctx.sourceId !== undefined ? { sourceId: ctx.sourceId } : {}),
      ...(ctx.event.scope ? { scope: ctx.event.scope } : {}),
    })
    return ctx.steps
  }

  /** Lo que corre al reanudar por la rama de `from` — si la pipeline no cambió mientras esperaba. */
  resume({ checkpoint, branch }: Resumption): Runnable[] {
    if (checkpoint.shape !== this.shape) {
      throw new Error(
        `Pipeline(${this.pipelineId}): cambió mientras estaba pausada (era "${checkpoint.shape}", es "${this.shape}") — no se puede reanudar`,
      )
    }
    return this.graph.pause(checkpoint.pauseId).targetsOf(branch)
  }
}
