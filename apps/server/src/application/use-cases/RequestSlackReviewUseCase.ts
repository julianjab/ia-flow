import type { IRepoRepository } from '@ia-flow/agent-engine'
import type { IssueItem, ProjectSource, SourceItem } from '@ia-flow/issue-sources'
import { defaultToIssueItem, isCiFinished, openPullRequests } from '@ia-flow/issue-sources'
import type { Project, PullRequestRef, SlackMemberRef } from '@ia-flow/shared'
import {
  ProjectSettingsSchema,
  type SlackReviewKind,
  buildSlackReviewMessage,
  resolveSlackReviewTarget,
  slackReviewBlockedReason,
} from '@ia-flow/shared'
import { createLogger } from '../../logger.js'

const log = createLogger('slack-review')

/** Lo que este use-case necesita de Slack. Angosto a propósito: no le importa
 *  cómo se autentica ni qué más sabe hacer el cliente. */
export interface SlackPostPort {
  postMessage(input: { channel: string; text: string; thread_ts?: string }): Promise<{
    channel: string
    ts: string
  }>
  getPermalink(input: { channel: string; message_ts: string }): Promise<string>
}

export interface IProjectLookup {
  get(projectId: string): Project | null
}

export interface RequestSlackReviewInput {
  projectId: string
  taskId: string
  /** Publicar aunque el CI haya terminado en rojo. La UI lo manda cuando el
   *  operador confirmó; sin esto un PR con CI fallido igual se puede pedir por
   *  error desde la API. */
  allowFailedCi?: boolean
}

export interface RequestSlackReviewResult {
  kind: SlackReviewKind
  threadUrl?: string
  channel: string
  reviewers: SlackMemberRef[]
  prNumber: number
  /** El link no se pudo guardar: el pedido salió igual, pero el próximo va a
   *  abrir un hilo nuevo. La UI lo muestra como warning, no como error. */
  threadNotPersisted?: string
}

export class SlackReviewError extends Error {}

/**
 * Pide review de la tarea en Slack: taguea a los reviewers del repo en su canal
 * y —si ya hubo un pedido— contesta DENTRO del mismo hilo.
 *
 * El orden de los pasos no es casual: todo lo que puede fallar sin efectos
 * (resolver el PR, el CI, el canal, los reviewers) pasa ANTES de publicar. Una
 * vez que el mensaje salió, nada vuelve atrás — por eso guardar el link del
 * hilo es best-effort y se reporta como warning en vez de tumbar el request.
 */
export class RequestSlackReviewUseCase {
  constructor(
    private readonly repoRepo: IRepoRepository,
    private readonly projectRepo: IProjectLookup,
    private readonly slack: SlackPostPort,
  ) {}

  async execute(
    input: RequestSlackReviewInput,
    source: ProjectSource,
  ): Promise<RequestSlackReviewResult> {
    const project = this.projectRepo.get(input.projectId)
    if (!project) throw new SlackReviewError(`Proyecto '${input.projectId}' no encontrado`)

    const item = await this.loadItem(source, input.taskId)
    const pr = openPullRequests(item.meta?.pullRequests as PullRequestRef[] | undefined)[0]
    if (!pr) throw new SlackReviewError('La tarea no tiene ningún PR abierto')
    if (!isCiFinished(pr)) {
      throw new SlackReviewError(`El CI del PR #${pr.number} todavía está corriendo`)
    }
    if (!input.allowFailedCi && (pr.ci === 'failure' || pr.ci === 'error')) {
      throw new SlackReviewError(
        `El CI del PR #${pr.number} terminó en ${pr.ci} — confirmá para pedir review igual`,
      )
    }

    const target = resolveSlackReviewTarget(
      this.resolveRepo(item, input.projectId),
      // El bag de settings es abierto: se parsea acá para no leer campos a
      // ciegas de un `Record<string, unknown>`.
      ProjectSettingsSchema.partial().safeParse(project.settings ?? {}).data,
    )
    const blocked = slackReviewBlockedReason(target)
    if (blocked || !target.channel) throw new SlackReviewError(blocked ?? 'Falta canal de Slack')

    const previousThread = await source.getSlackThreadUrl?.(item)
    const kind: SlackReviewKind = previousThread ? 're-review' : 'first'

    const posted = await this.slack.postMessage({
      channel: target.channel,
      text: buildSlackReviewMessage({
        kind,
        reviewers: target.reviewers,
        prUrl: pr.url,
        prTitle: pr.title,
        messages: target.messages,
      }),
      ...(previousThread ? { thread_ts: threadTsFrom(previousThread) } : {}),
    })

    // ── A partir de acá el mensaje YA está publicado ───────────────────────
    const threadUrl =
      previousThread ?? (await this.permalink(posted.channel, posted.ts)) ?? undefined

    const result: RequestSlackReviewResult = {
      kind,
      channel: target.channel,
      reviewers: target.reviewers,
      prNumber: pr.number,
      ...(threadUrl ? { threadUrl } : {}),
    }

    if (!previousThread && threadUrl) {
      const failure = await this.persistThread(source, item, threadUrl)
      if (failure) result.threadNotPersisted = failure
    }
    return result
  }

  private async loadItem(source: ProjectSource, taskId: string): Promise<IssueItem> {
    const raw: SourceItem | null = (await source.getItemById?.(taskId)) ?? null
    if (!raw) throw new SlackReviewError(`Tarea '${taskId}' no encontrada en la fuente`)
    return source.toIssueItem ? source.toIssueItem(raw) : defaultToIssueItem(raw)
  }

  /** El repo primario de la task — el que resuelve cwd y, acá, los reviewers. */
  private resolveRepo(item: IssueItem, projectId: string) {
    const name = item.repos?.[0]
    return name ? (this.repoRepo.getByProject(name, projectId) ?? undefined) : undefined
  }

  private async permalink(channel: string, ts: string): Promise<string | undefined> {
    try {
      return await this.slack.getPermalink({ channel, message_ts: ts })
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'No se pudo resolver el permalink del hilo')
      return undefined
    }
  }

  private async persistThread(
    source: ProjectSource,
    item: IssueItem,
    threadUrl: string,
  ): Promise<string | undefined> {
    if (!source.setSlackThreadUrl) {
      return `La fuente '${source.kind}' no guarda el link del hilo: el próximo pedido va a abrir uno nuevo`
    }
    try {
      await source.setSlackThreadUrl(item, threadUrl)
      return undefined
    } catch (err) {
      const msg = (err as Error).message
      log.warn({ err: msg, taskId: item.id }, 'No se pudo guardar el link del hilo')
      return msg
    }
  }
}

/**
 * De un permalink de Slack al `ts` del mensaje raíz.
 *
 * `https://x.slack.com/archives/C123/p1699999999123456` → `1699999999.123456`.
 * Un `thread_ts` que no matchea el formato se manda igual: Slack lo rechaza con
 * un error claro, y adivinar sería peor.
 */
function threadTsFrom(permalink: string): string | undefined {
  const p = permalink.match(/\/p(\d{10})(\d{6})/)
  if (p) return `${p[1]}.${p[2]}`
  // Algunos permalinks traen el hilo en query (`?thread_ts=…`).
  return new URL(permalink, 'https://slack.com').searchParams.get('thread_ts') ?? undefined
}
