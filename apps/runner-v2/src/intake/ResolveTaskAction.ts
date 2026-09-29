import {
  Action,
  type DomainEvent,
  deriveEvent,
  type PipelineExecutionContext,
} from '@ia-tools/agent-pipeline'
import { z } from 'zod'
import type { BoardRef, GithubTaskReader } from './GithubTaskReader.js'
import { type EventFields, locate, mergedBlocker } from './locate.js'
import { boardItem, issueRefs, linkedIssue, taskPayload } from './task.js'

/** El proyecto para el que resuelve: su board, su prefijo de rama y su catálogo de repos. */
export interface ResolveTaskProject {
  id: string
  board: BoardRef
  branchPrefix: string
  /** `owner/repo` de cada repo del catálogo. */
  repos: string[]
  /** `{{project.repos}}` de los prompts: el catálogo en texto. */
  reposText: string
}

const Input = z.strictObject({
  /** En vez del evento de la task: `issue.unblocked` para cada task que el merge de este PR dejó
   *  sin prerrequisitos abiertos (`mark_blocked_by`). */
  unblockDependents: z.boolean().optional(),
})

/** Lo que hizo con un webhook, para la traza y el log. */
export type Resolved = { emitted: string[] } | { skipped: string }

/** La task de un webhook: un issue, y el PR del evento si trae uno. */
interface TaskRef {
  owner: string
  repo: string
  number: number
  pr?: number
}

const UNBLOCKED = 'issue.unblocked'
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * `resolve_task`: el intake entero en un paso. De un webhook crudo de GitHub (`github.<evento>`)
 * encuentra la task (`locate`), la lee de GitHub —la card de ESTE board, el issue, sus blockers,
 * el timeline del issue y del PR, el CI— y publica el evento de la task con el payload que ven los
 * agentes y el scope `{projectId, repo, issue}`: desde ahí corre como una ejecución de esa task.
 *
 * No publica nada para un repo que el catálogo no declara, ni para un issue que no está en el board
 * del proyecto (es de otro engine: el de producción comparte los repos).
 */
export class ResolveTaskAction extends Action<typeof Input, Resolved> {
  readonly description = 'Resuelve la task de un webhook de GitHub y publica su evento'
  readonly input = Input
  override readonly sideEffects = 'none' as const

  constructor(
    private readonly project: ResolveTaskProject,
    private readonly reader: GithubTaskReader,
  ) {
    super({ id: 'resolve_task' })
  }

  async execute(input: z.infer<typeof Input>, ctx: PipelineExecutionContext): Promise<Resolved> {
    const raw = (ctx.event.payload ?? {}) as Record<string, unknown>
    const type = ctx.event.type.replace(/^github\./, '')
    if (input.unblockDependents) return this.unblocked(raw, ctx)

    const location = locate(type, raw, this.project.branchPrefix)
    if ('skip' in location) return { skipped: location.skip }
    const task =
      'item' in location ? await this.itemTask(location.item) : await this.issueTask(location)
    if ('skipped' in task) return task
    const event = await this.publish(ctx, task, location)
    return event ? { emitted: [String(event.scope?.issue)] } : { skipped: 'sin evento' }
  }

  /** El issue detrás de un item, si el item es del board de este proyecto. */
  private async itemTask(itemId: string): Promise<TaskRef | { skipped: string }> {
    const found = await this.reader.issueOfItem(itemId)
    if (!found) return { skipped: `no se pudo leer el item ${itemId}` }
    const { board } = this.project
    if (found.board.number !== board.number || !same(found.board.owner, board.owner)) {
      return { skipped: `item del board ${found.board.owner}#${found.board.number}` }
    }
    return { owner: found.owner, repo: found.repo, number: found.number }
  }

  private async issueTask(location: {
    owner: string
    repo: string
    number?: number
    pr?: number
    inspect?: number
  }): Promise<TaskRef | { skipped: string }> {
    const { owner, repo } = location
    // Antes de leer nada: un repo que el catálogo no declara no es de este proyecto.
    if (!this.project.repos.some((full) => same(full, `${owner}/${repo}`))) {
      return { skipped: `${owner}/${repo} no es del catálogo de ${this.project.id}` }
    }
    let number = location.number
    if (location.inspect !== undefined) {
      const pr = await this.reader.pull(owner, repo, location.inspect)
      number =
        linkedIssue(pr.head.ref, pr.body ?? '', this.project.branchPrefix) ?? location.inspect
    }
    if (number === undefined) return { skipped: 'el webhook no dice de qué issue es' }
    return { owner, repo, number, ...(location.pr !== undefined ? { pr: location.pr } : {}) }
  }

  /**
   * Lee la task y publica su evento. Sin card en el board de este proyecto no publica nada;
   * con `onlyIfUnblocked`, tampoco si le queda algún blocker abierto (sin contar `closedBlocker`).
   */
  private async publish(
    ctx: PipelineExecutionContext,
    task: TaskRef,
    fields: EventFields,
    options: { closedBlocker?: string; onlyIfUnblocked?: boolean } = {},
  ): Promise<DomainEvent<unknown> | undefined> {
    const card = boardItem(
      await this.reader.itemsOfIssue(task.owner, task.repo, task.number),
      this.project.board,
    )
    if (!card) return undefined
    const context = await this.reader.context({
      ...task,
      branch: `${this.project.branchPrefix}${task.number}`,
    })
    const built = taskPayload({
      ...task,
      ...fields,
      ...context,
      card,
      ...(options.closedBlocker ? { closedBlocker: options.closedBlocker } : {}),
      projectId: this.project.id,
      branchPrefix: this.project.branchPrefix,
      repos: this.project.reposText,
    })
    if (options.onlyIfUnblocked && built.blocked) return undefined
    const event = deriveEvent(ctx.event, built.type, built.payload, {
      scope: built.scope,
      ...(ctx.execution ? { executionId: ctx.execution.id } : {}),
    })
    await ctx.bus.publish(event)
    return event
  }

  /** `issue.unblocked` para cada dependiente abierto del issue que cierra el PR mergeado que ya no
   *  tiene otro blocker abierto. El recién cerrado no cuenta: el webhook del merge puede llegar
   *  antes que su cierre. */
  private async unblocked(
    raw: Record<string, unknown>,
    ctx: PipelineExecutionContext,
  ): Promise<Resolved> {
    const blocker = mergedBlocker(raw, this.project.branchPrefix)
    if ('skip' in blocker) return { skipped: blocker.skip }
    const closedBlocker = `https://github.com/${blocker.owner}/${blocker.repo}/issues/${blocker.number}`
    const dependents = issueRefs(
      await this.reader.dependents(blocker.owner, blocker.repo, blocker.number),
      this.project.repos,
    )
    const emitted: string[] = []
    for (const dependent of dependents) {
      const event = await this.publish(
        ctx,
        dependent,
        { emit: UNBLOCKED, extra: {} },
        { closedBlocker, onlyIfUnblocked: true },
      )
      if (event) emitted.push(String(event.scope?.issue))
    }
    return emitted.length > 0
      ? { emitted }
      : { skipped: `#${blocker.number} no deja ninguna task sin prerrequisitos` }
  }
}
