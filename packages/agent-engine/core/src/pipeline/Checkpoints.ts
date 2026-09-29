import type { Pause } from './actions/Pause.js'
import type { Checkpoint, Resumption } from './Pipeline.js'
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
      ...this.checkpoint(ctx, pause.pauseId, resumeAt),
      ...(pause.state !== undefined ? { state: pause.state } : {}),
    })
    return ctx.steps
  }

  /** `step` guarda por dónde va (su `state`), o lo borra (`undefined`: terminó). Sin ejecución, o
   *  sin id por el que encontrarlo al retomar, no hay nada que guardar. */
  progress(ctx: PipelineExecutionContext, step: Runnable, resumeAt: number, state: unknown): void {
    if (!ctx.execution?.progress || step.id === undefined) return
    ctx.execution.progress(
      state === undefined
        ? undefined
        : {
            ...this.checkpoint(ctx, step.id, resumeAt),
            steps: { ...ctx.steps },
            state,
            ...(ctx.resume?.attempts ? { attempts: ctx.resume.attempts } : {}),
          },
    )
  }

  private checkpoint(ctx: PipelineExecutionContext, pauseId: string, resumeAt: number): Checkpoint {
    return {
      pipelineId: this.pipelineId,
      pauseId,
      resumeAt,
      steps: ctx.steps,
      shape: this.shape,
      savedAt: new Date().toISOString(),
      ...(ctx.sourceId !== undefined ? { sourceId: ctx.sourceId } : {}),
      ...(ctx.event.scope ? { scope: ctx.event.scope } : {}),
    }
  }

  /** Lo que corre al reanudar por la rama de `from` — si la pipeline no cambió mientras esperaba. */
  resume({ checkpoint, branch }: Resumption): Runnable[] {
    if (checkpoint.shape !== this.shape) {
      throw new Error(
        `Pipeline(${this.pipelineId}): cambió mientras estaba pausada (era "${checkpoint.shape}", es "${this.shape}") — no se puede reanudar`,
      )
    }
    return this.graph.resumeTargets(checkpoint.pauseId, branch)
  }
}
