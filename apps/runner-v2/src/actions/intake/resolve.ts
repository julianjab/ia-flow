/**
 * Base de las Actions de resolución — el primer paso (`id: 'resolve'`) de cada pipeline de
 * entrada (`intake.ts`). Un webhook entra al engine CRUDO (`github.<evento>`, el payload tal
 * cual lo mandó GitHub); la Action de su evento hace las lecturas que el agente necesita (a qué
 * proyecto pertenece, qué issue implementa el PR, en qué columna del board está la card) y
 * devuelve el payload completo — el mismo que la CLI arma con flags (`buildPayload`). El
 * `EmitAction` siguiente de la pipeline lo publica con el nombre que escuchan las reglas.
 *
 * Lo que una Action NO decide: qué eventos entran (el `on`/`when` de la pipeline de entrada) ni
 * con qué nombre salen (el `EmitAction`). Devuelve `emit` para que la pipeline elija cuál de
 * sus `EmitAction` corre, pero el vocabulario vive en `intake.ts`.
 */
import { Action, type PipelineExecutionContext } from '@ia-tools/agent-pipeline'
import type { GithubClient } from '@ia-tools/github-api'
import { z } from 'zod'
import type { BoardItem, BoardReader, BoardRef } from '../../board-reader.js'
import { buildPayload, DEFAULT_BRANCH_PREFIX, type EventArgs } from '../../event.js'
import type { TaskContextReader } from './task-context.js'

export interface IntakeProject {
  id: string
  board: BoardRef
  /** El prefijo de rama de las tasks de este proyecto — el que abre el implementer. */
  branchPrefix: string
  /** `{{project.repos}}` de los prompts: el catálogo de repos del proyecto, en texto. */
  repos: string
}

/** Lo que las Actions de resolución leen del mundo — una interfaz para testearlas sin red. */
export interface IntakeContext {
  /** El proyecto que declara `owner/repo` en su catálogo — estricto, sin fallback. */
  projectForRepo(owner: string, repo: string): IntakeProject | undefined
  /** El proyecto cuyo board es `board`. */
  projectForBoard(board: BoardRef): IntakeProject | undefined
  reader: BoardReader
  /** Comentarios, CI y PR de la task — `{{task.comments}}`, `{{task.ci}}`, `{{task.pr.*}}`. */
  taskContext: TaskContextReader
  /** Rama y body de un PR — para ubicar el issue de un comentario hecho en el PR. */
  pullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{ headRef: string; body: string }>
  /** Para leer título/body del issue; sin cliente no se lee (dry-run). */
  client?: GithubClient
  /** Último Status visto por item (node id) — el `from` cuando GitHub no lo manda. */
  lastStatus: Map<string, string | undefined>
  log(line: string): void
}

export type Resolution =
  | { emit: string; projectId: string; task: string; payload: Record<string, unknown> }
  | { emit: null; reason: string }

/**
 * El issue que un PR implementa: la rama `<branchPrefix><n>` que abre el implementer
 * (`task.branch`), o una referencia de cierre (`Closes #n`) en el body.
 */
export function linkedIssue(
  headRef: string,
  body = '',
  branchPrefix: string = DEFAULT_BRANCH_PREFIX,
): number | undefined {
  if (headRef.startsWith(branchPrefix)) {
    const n = headRef.slice(branchPrefix.length)
    if (/^\d+$/.test(n)) return Number(n)
  }
  const closing = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i)
  return closing?.[1] ? Number(closing[1]) : undefined
}

/** Los `EventArgs` de una task con lo que el board dice de ella. */
export function taskArgs(
  eventType: string,
  target: { owner: string; repo: string; number: number },
  item: BoardItem | undefined,
  labels: string[] = [],
): EventArgs {
  return {
    eventType,
    ...target,
    status: item?.status,
    type: item?.type ?? 'technical',
    // Vacío = `buildPayload` usa las labels reales del issue.
    labels,
    author: '',
    commentId: 0,
    sets: [],
  }
}

const NoInput = z.strictObject({})

export abstract class ResolveAction extends Action<typeof NoInput, Resolution> {
  readonly input = NoInput
  override readonly sideEffects = 'none' as const

  constructor(protected readonly intake: IntakeContext) {
    super({ id: 'resolve' })
  }

  /** Lo que la Action sabe hacer con el payload crudo del webhook. */
  protected abstract resolve(raw: Record<string, unknown>): Promise<Resolution>

  async execute(
    _input: z.infer<typeof NoInput>,
    ctx: PipelineExecutionContext,
  ): Promise<Resolution> {
    const result = await this.resolve(ctx.event.payload as Record<string, unknown>)
    this.intake.log(
      result.emit !== null
        ? `→ ${ctx.event.type} → ${result.emit} ${result.task} (${result.projectId})`
        : `· ${ctx.event.type} ignorado: ${result.reason}`,
    )
    return result
  }

  protected skip(reason: string): Resolution {
    return { emit: null, reason }
  }

  /** Una task que no es item del board de este runner no es suya — mismo criterio que ia-flow
   *  (`AgentAction`: "el evento no apunta a ningún issue de este proyecto"). Es lo que deja
   *  convivir a este runner con otro engine sobre los mismos repos: cada uno trabaja sólo las
   *  cards de SU board. */
  protected notOnBoard(project: IntakeProject, owner: string, repo: string, number: number) {
    return this.skip(
      `${owner}/${repo}#${number} no está en el board ${project.board.owner}#${project.board.number}`,
    )
  }

  /** Lee el item del board y lo recuerda — el `from` de un próximo cambio de Status. */
  protected async boardItem(project: IntakeProject, owner: string, repo: string, number: number) {
    const item = await this.intake.reader.itemForIssue(project.board, owner, repo, number)
    if (item) this.intake.lastStatus.set(item.itemId, item.status)
    return item
  }

  /** El payload completo de `args` — el mismo camino que un evento de la CLI, más el contexto de
   *  la task (comentarios, CI, PR) que un delivery no trae y la CLI no pide. */
  protected async emit(project: IntakeProject, args: EventArgs): Promise<Resolution> {
    const context = await this.intake.taskContext.load({
      owner: args.owner,
      repo: args.repo,
      number: args.number,
      pr: args.pr,
      branch: `${project.branchPrefix}${args.number}`,
    })
    args.taskExtra = {
      comments: context.comments,
      ci: context.ci,
      ...(context.pr ? { pr: context.pr } : {}),
      // `{{task.blockers}}`: qué la frena, legible para el prompt.
      blockers: context.blockers.map((b) => `#${b.number} ${b.title} (${b.url})`).join('\n'),
    }
    // Lo que filtra el gate de `allowBlocked` (`rules.ts`): hay prerrequisitos abiertos.
    args.itemExtra = { blocked: context.blockers.length > 0 }
    return {
      emit: args.eventType,
      projectId: project.id,
      task: `${args.owner}/${args.repo}#${args.number}`,
      payload: await buildPayload(args, this.intake.client, project),
    }
  }
}
