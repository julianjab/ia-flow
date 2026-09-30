import {
  Action,
  type DomainEvent,
  deriveEvent,
  type PipelineExecutionContext,
} from '@ia-flow/agent-engine'
import { type BoardRef, boardItem, type GithubTaskReader, issueRefs } from '@ia-flow/github-tools'
import { type EventFields, type Location, locate, mergedPullRequest } from '@ia-flow/github-webhook'
import { z } from 'zod'
import { TaskBranches } from './branch.js'
import { eventMessage } from './message.js'
import { locateSlack, type SlackLocateDeps } from './slack.js'
import { taskPayload } from './task.js'

/** Un proyecto para el que resuelve: su board, su prefijo de rama y su catálogo de repos. */
export interface ResolveTaskProject {
  id: string
  board: BoardRef
  /** Con prefijo, la rama de la task es `<prefijo><número>`; sin él, como ia-flow (ver
   *  `TaskBranches`). */
  branchPrefix?: string
  /** `owner/repo` de cada repo del catálogo. */
  repos: string[]
  /** `{{project.repos}}` de los prompts: el catálogo en texto. */
  reposText: string
  /** Sólo las cards con esta label son de este runner (ver `runner.yaml`). */
  label?: string
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
 * `resolve_task`: el intake entero en un paso, para TODOS los proyectos. De un webhook crudo de
 * GitHub (`github.<evento>`) decide de qué proyecto es —el board del item, el catálogo de repos,
 * la card del issue y la label— y, por cada uno, encuentra la task (`locate`), la lee de GitHub
 * —la card de ese board, el issue, sus blockers, el timeline del issue y del PR, el CI— y publica
 * el evento de la task con el payload que ven los agentes (y su `message`) y el scope
 * `{projectId, repo, issue}`: desde ahí sólo lo ve la fuente de ese proyecto.
 *
 * No publica nada para un repo que ningún catálogo declara, ni para un issue que no está en el
 * board de ningún proyecto (es de otro engine: el de producción comparte los repos).
 */
export class ResolveTaskAction extends Action<typeof Input, Resolved> {
  readonly description = 'Resuelve la task de un webhook de GitHub y publica su evento'
  readonly input = Input
  override readonly sideEffects = 'none' as const

  constructor(
    private readonly projects: () => ResolveTaskProject[],
    private readonly reader: GithubTaskReader,
    /** Para las respuestas de un hilo de Slack (`slack.message`); sin esto se saltan. */
    private readonly slack?: SlackLocateDeps,
  ) {
    super({ id: 'resolve_task' })
  }

  async execute(input: z.infer<typeof Input>, ctx: PipelineExecutionContext): Promise<Resolved> {
    const projects = this.projects()
    if (projects.length === 0) return { skipped: 'no hay proyectos montados' }
    // Slack se lee una vez, aunque haya varios proyectos: dice de qué repo y PR es el hilo.
    let slackLocation: Location | undefined
    if (ctx.event.type.startsWith('slack.')) {
      if (!this.slack) return { skipped: 'Slack no está configurado para el intake' }
      slackLocation = await locateSlack(
        (ctx.event.payload ?? {}) as Record<string, unknown>,
        this.slack,
      )
      if ('skip' in slackLocation) return { skipped: slackLocation.skip }
    }
    // Un item del board se lee una vez aunque haya varios proyectos.
    const reader = this.reader.withItemCache()
    const results = await Promise.all(
      projects.map((project) =>
        new ProjectResolver(project, reader).resolve(input, ctx, slackLocation),
      ),
    )
    const emitted = results.flatMap((result) => ('emitted' in result ? result.emitted : []))
    if (emitted.length > 0) return { emitted }
    return {
      skipped: results
        .map((result, i) => `${projects[i]?.id}: ${'skipped' in result ? result.skipped : ''}`)
        .join(' · '),
    }
  }
}

/** Lo que `resolve_task` hace para UN proyecto. */
class ProjectResolver {
  constructor(
    private readonly project: ResolveTaskProject,
    private readonly reader: GithubTaskReader,
  ) {}

  async resolve(
    input: z.infer<typeof Input>,
    ctx: PipelineExecutionContext,
    located?: Location,
  ): Promise<Resolved> {
    const raw = (ctx.event.payload ?? {}) as Record<string, unknown>
    const type = ctx.event.type.replace(/^github\./, '')
    if (input.unblockDependents) return this.unblocked(raw, ctx)

    const location = located ?? locate(type, raw)
    if ('skip' in location) return { skipped: location.skip }
    const task =
      'item' in location ? await this.itemTask(location.item) : await this.issueTask(location)
    if ('skipped' in task) return task
    const published = await this.publish(ctx, task, location)
    return 'skip' in published
      ? { skipped: published.skip }
      : { emitted: [String(published.scope?.issue)] }
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
    if (!this.inCatalog(owner, repo)) {
      return { skipped: `${owner}/${repo} no es del catálogo de ${this.project.id}` }
    }
    const pr = location.pr !== undefined ? { pr: location.pr } : {}
    if (location.number !== undefined) return { owner, repo, number: location.number, ...pr }
    if (location.inspect === undefined) return { skipped: 'el webhook no dice de qué issue es' }
    // El issue de un PR lo dice GitHub (lo que el PR cierra), no el nombre de su rama. Puede ser de
    // otro repo: vale el primero que sea de este proyecto.
    const closing = (await this.reader.closingIssues(owner, repo, location.inspect)).find((issue) =>
      this.inCatalog(issue.owner, issue.repo),
    )
    // Un PR sin issue no es una task: su número no resuelve como `Issue`.
    if (!closing) return { skipped: `PR #${location.inspect} no cierra ningún issue` }
    return { ...closing, ...pr }
  }

  private inCatalog(owner: string, repo: string): boolean {
    return this.project.repos.some((full) => same(full, `${owner}/${repo}`))
  }

  /**
   * Lee la task y publica su evento. No publica nada —y dice por qué— si no tiene card en el
   * board del proyecto, si no tiene la `label` del proyecto (es de otro engine), o, con
   * `onlyIfUnblocked`, si le queda algún blocker abierto (sin contar `closedBlocker`).
   */
  private async publish(
    ctx: PipelineExecutionContext,
    task: TaskRef,
    fields: EventFields,
    options: { closedBlocker?: string; onlyIfUnblocked?: boolean } = {},
  ): Promise<DomainEvent<unknown> | { skip: string }> {
    const ref = `${task.owner}/${task.repo}#${task.number}`
    const card = boardItem(
      await this.reader.itemsOfIssue(task.owner, task.repo, task.number),
      this.project.board,
    )
    if (!card) return { skip: `${ref} no está en el board de ${this.project.id}` }
    const branches = new TaskBranches(this.reader, this.project.branchPrefix)
    const known = await branches.known(task)
    const context = await this.reader.context(task)
    const { label } = this.project
    const labels = context.issue.labels.map((l) => (typeof l === 'string' ? l : l.name))
    if (label && !labels.includes(label)) {
      return { skip: `${ref} no tiene la label \`${label}\`: no es de este runner` }
    }
    // Recién acá, con la task ya confirmada de este runner: proponer un nombre puede costar un modelo.
    const branch =
      known ?? (await branches.propose(task, { ...context.issue, type: card.type }, ctx))
    const built = taskPayload({
      ...task,
      ...fields,
      ...context,
      card,
      ...(options.closedBlocker ? { closedBlocker: options.closedBlocker } : {}),
      projectId: this.project.id,
      branch,
      repos: this.project.reposText,
    })
    if (options.onlyIfUnblocked && built.blocked) return { skip: `${ref} sigue bloqueada` }
    const payload = { ...built.payload, message: eventMessage(built.type, built.payload) }
    const event = deriveEvent(ctx.event, built.type, payload, {
      scope: built.scope,
      ...(ctx.execution ? { executionId: ctx.execution.id } : {}),
    })
    await ctx.bus.publish(event)
    return event
  }

  /** `issue.unblocked` para cada dependiente abierto de los issues que cierra el PR mergeado que ya
   *  no tienen otro blocker abierto. El recién cerrado no cuenta: el webhook del merge puede llegar
   *  antes que su cierre. */
  private async unblocked(
    raw: Record<string, unknown>,
    ctx: PipelineExecutionContext,
  ): Promise<Resolved> {
    const merged = mergedPullRequest(raw)
    if ('skip' in merged) return { skipped: merged.skip }
    const blockers = (await this.reader.closingIssues(merged.owner, merged.repo, merged.pr)).filter(
      (issue) => this.inCatalog(issue.owner, issue.repo),
    )
    if (blockers.length === 0) return { skipped: `PR #${merged.pr} no cierra ningún issue` }
    const emitted: string[] = []
    for (const blocker of blockers) {
      const closedBlocker = `https://github.com/${blocker.owner}/${blocker.repo}/issues/${blocker.number}`
      const dependents = issueRefs(
        await this.reader.dependents(blocker.owner, blocker.repo, blocker.number),
        this.project.repos,
      )
      for (const dependent of dependents) {
        const published = await this.publish(
          ctx,
          dependent,
          { emit: UNBLOCKED, extra: {} },
          { closedBlocker, onlyIfUnblocked: true },
        )
        if (!('skip' in published)) emitted.push(String(published.scope?.issue))
      }
    }
    return emitted.length > 0
      ? { emitted }
      : { skipped: `PR #${merged.pr} no deja ninguna task sin prerrequisitos` }
  }
}
