import type { DomainEvent, PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { WorktreeNameSource } from '../layout.js'
import type { CloneableRepo, WorkspaceManager } from '../WorkspaceManager.js'

/** Qué checkout necesita una corrida. Lo arma la app desde su evento — este paquete no conoce la
 *  forma del payload. */
export interface WorkspaceTarget {
  /** La task: `id` + `issueNumber`/`title` deciden el nombre legible del worktree. */
  task: WorktreeNameSource
  /** El repo a clonar (una vez, persistente). */
  repo: CloneableRepo
  /** La branch a checkoutear. Default `task/<id>` (`branchNameFor`). */
  branch?: string
}

export type WorkspaceTargetResolver = (ctx: PipelineExecutionContext) => WorkspaceTarget

export interface PreparedWorkspace {
  target: WorkspaceTarget
  /** El worktree, listo para las tools de disco. */
  path: string
  /** La branch que el manager terminó usando. */
  branch: string
  /** El clone del que cuelga el worktree. */
  repoBasePath: string
}

/**
 * El checkout de CADA corrida, a demanda: la primera tool de disco que el agente llama en una
 * corrida clona (si hace falta) y crea o reusa el worktree con el `WorkspaceManager`; el resto de
 * sus llamadas en esa corrida reusan el mismo resultado (la clave es el evento que la disparó).
 * Un agente que nunca toca disco no paga ni el fetch.
 *
 * No toma el lock por task del manager: el engine no tiene un "fin de corrida" donde soltarlo.
 * Lo que sí queda serializado es git sobre el mismo clone (el lock por repo del manager); que
 * dos corridas de la MISMA task no se pisen es trabajo del que despacha (p. ej. una cola por
 * task).
 */
export class WorkspaceSession {
  private readonly byEvent = new WeakMap<DomainEvent, Promise<PreparedWorkspace>>()

  constructor(
    readonly manager: WorkspaceManager,
    private readonly resolveTarget: WorkspaceTargetResolver,
  ) {}

  prepare(ctx: PipelineExecutionContext): Promise<PreparedWorkspace> {
    let prepared = this.byEvent.get(ctx.event)
    if (!prepared) {
      prepared = this.create(ctx)
      this.byEvent.set(ctx.event, prepared)
      // Un fallo no queda cacheado: la próxima tool de la corrida lo reintenta.
      prepared.catch(() => this.byEvent.delete(ctx.event))
    }
    return prepared
  }

  /** El workspace que esta corrida ya preparó, si alguna tool lo pidió. */
  prepared(ctx: PipelineExecutionContext): Promise<PreparedWorkspace> | undefined {
    return this.byEvent.get(ctx.event)
  }

  async dirFor(ctx: PipelineExecutionContext): Promise<string> {
    return (await this.prepare(ctx)).path
  }

  private async create(ctx: PipelineExecutionContext): Promise<PreparedWorkspace> {
    const target = this.resolveTarget(ctx)
    const repoBasePath = await this.manager.ensureLocalClone(target.repo)
    const { path, branch } = await this.manager.getOrCreateWorktree(target.task, repoBasePath, {
      branch: target.branch,
    })
    return { target, path, branch, repoBasePath }
  }
}
