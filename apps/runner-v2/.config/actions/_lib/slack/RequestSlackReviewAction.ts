import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { readSection, writeSection } from '@ia-flow/github-tools'
import {
  buildSlackReviewMessage,
  mapAssigneesToSlack,
  resolveSlackReviewTarget,
  type SlackClient,
  type SlackReviewConfig,
  type SlackUserDirectory,
  slackReviewBlockedReason,
  threadTsOf,
} from '@ia-flow/slack-api'
import { z } from 'zod'

/** El bloque del body del issue donde queda el link del hilo (`<!-- ia-flow:slack -->`). */
export const SLACK_SECTION = 'slack'

const Input = z.strictObject({
  allowFailedCi: z
    .boolean()
    .optional()
    .describe('Pedir review aunque el CI haya terminado en rojo. Default: no.'),
})

export interface RequestSlackReviewOptions {
  github: GithubClient
  slack: SlackClient
  /** Login de GitHub → usuario de Slack (`slack.users` de runner.yaml): a quién taguear según los
   *  asignados del issue. */
  users?: SlackUserDirectory
  /** Canal, reviewers y textos del proyecto. */
  project: SlackReviewConfig
  /** Los del repo de la task (`owner/repo`), que pisan los del proyecto campo por campo. */
  repo: (owner: string, repo: string) => SlackReviewConfig | undefined
}

interface Task {
  owner: string
  repo: string
  number: number
  branch?: string
  prNumber?: number
}

interface PullRequest {
  number: number
  title: string
  html_url: string
  head: { sha: string }
}

/**
 * `request_slack_review`: taguea a los asignados del issue (los que tienen usuario de Slack en
 * `slack.users`) Y a los reviewers del repo, en el canal del repo, con el PR de la task y —si
 * ya hubo un pedido— contesta DENTRO del mismo hilo (re-review). El link del hilo vive en el
 * bloque `## Slack` del body del issue; `update_issue_body` lo conserva.
 *
 * Todo lo que puede fallar sin efectos (el PR, su CI, el canal, los reviewers) se valida ANTES de
 * publicar; guardar el link después es best-effort — el pedido ya salió.
 */
export class RequestSlackReviewAction extends Action<typeof Input, string> {
  readonly description =
    'Pide review del PR de la task en Slack: taguea a los asignados del issue (según `slack.users` de runner.yaml) y a los reviewers del repo, en el canal del repo; o contesta en el hilo del pedido anterior si ya hubo uno. Falla si no hay un PR abierto o si su CI no terminó (o terminó en rojo, salvo `allowFailedCi`).'
  readonly input = Input

  constructor(private readonly options: RequestSlackReviewOptions) {
    super({ id: 'request_slack_review' })
  }

  async execute(input: z.infer<typeof Input>, ctx: PipelineExecutionContext): Promise<string> {
    const { github, slack } = this.options
    if (!slack.enabled) throw new Error('Slack no está configurado (SLACK_BOT_TOKEN)')
    const task = taskFrom(ctx)
    const pr = await this.pullRequest(task)
    await this.assertCi(task, pr, input.allowFailedCi ?? false)
    // Se lee el issue ANTES de validar el destino: sus asignados deciden a quién se taguea.
    const issuePath = `/repos/${task.owner}/${task.repo}/issues/${task.number}`
    const issue = await github.requestJson<{
      body?: string | null
      assignees?: Array<{ login: string }> | null
    }>(issuePath)
    const body = issue.body ?? ''
    const { members, unmapped } = mapAssigneesToSlack(
      (issue.assignees ?? []).map((assignee) => assignee.login),
      this.options.users,
    )
    const target = resolveSlackReviewTarget(
      this.options.repo(task.owner, task.repo),
      this.options.project,
      members,
    )
    const blocked = slackReviewBlockedReason(target)
    if (blocked || !target.channel) {
      const reason = blocked ?? 'Falta el canal de Slack'
      throw new Error(
        unmapped.length > 0
          ? `${reason}. Los asignados del issue (${unmapped.join(', ')}) no tienen usuario de Slack: agregalos en runner.yaml → slack.users`
          : reason,
      )
    }

    const thread = readSection(body, SLACK_SECTION)?.match(/https?:\/\/\S+/)?.[0]
    const kind = thread ? 're-review' : 'first'
    const message = buildSlackReviewMessage({
      kind,
      reviewers: target.reviewers,
      prUrl: pr.html_url,
      prTitle: pr.title,
      messages: target.messages,
    })
    const posted = await slack.postMessage({
      channel: target.channel,
      // El mensaje que abre el hilo lleva SIEMPRE el issue y el PR: con ellos una respuesta en el
      // hilo se resuelve a su task sin buscar (`_lib/intake/slack.ts`), aunque la plantilla no los
      // incluya.
      text: thread
        ? message
        : withThreadRefs(message, `${task.owner}/${task.repo}#${task.number}`, pr.html_url),
      ...(thread ? { threadTs: threadTsOf(thread) } : {}),
    })
    if (thread) return `Re-review pedido en el hilo: ${thread}`

    // ── El pedido ya salió: lo que sigue no lo deshace ────────────────────
    try {
      const link = await slack.permalink(posted.channel, posted.ts)
      await github.requestJson(issuePath, {
        method: 'PATCH',
        body: JSON.stringify({ body: writeSection(body, SLACK_SECTION, `## Slack\n\n${link}`) }),
      })
      return `Review pedido en Slack: ${link}`
    } catch (error) {
      return `Review pedido en Slack, pero no se pudo guardar el link del hilo en el issue (${(error as Error).message}): el próximo pedido va a abrir un hilo nuevo.`
    }
  }

  /** El PR del evento, o el abierto desde la branch de la task. */
  private async pullRequest(task: Task): Promise<PullRequest> {
    const { github } = this.options
    const base = `/repos/${task.owner}/${task.repo}/pulls`
    if (task.prNumber) return github.requestJson<PullRequest>(`${base}/${task.prNumber}`)
    if (!task.branch) throw new Error('La task no tiene PR ni branch de la que buscarlo')
    const head = encodeURIComponent(`${task.owner}:${task.branch}`)
    const [open] = await github.requestJson<PullRequest[]>(`${base}?state=open&head=${head}`)
    if (!open) throw new Error(`La task no tiene un PR abierto (branch ${task.branch})`)
    return open
  }

  private async assertCi(task: Task, pr: PullRequest, allowFailed: boolean): Promise<void> {
    const { check_runs } = await this.options.github.requestJson<{
      check_runs: Array<{ name: string; status: string; conclusion: string | null }>
    }>(`/repos/${task.owner}/${task.repo}/commits/${pr.head.sha}/check-runs?per_page=100`)
    const running = check_runs.filter((run) => run.status !== 'completed')
    if (running.length > 0) {
      throw new Error(
        `El CI del PR #${pr.number} todavía corre: ${running.map((run) => run.name).join(', ')}`,
      )
    }
    const red = check_runs.filter((run) =>
      ['failure', 'timed_out', 'cancelled', 'action_required'].includes(run.conclusion ?? ''),
    )
    if (red.length > 0 && !allowFailed) {
      throw new Error(
        `El CI del PR #${pr.number} terminó en rojo (${red.map((run) => run.name).join(', ')}) — pasá allowFailedCi para pedir review igual`,
      )
    }
  }
}

/** El texto con el issue (`owner/repo#N`) y la URL del PR al final, si la plantilla no los trae. */
export function withThreadRefs(text: string, issueRef: string, prUrl: string): string {
  const missing = [
    text.includes(issueRef) ? undefined : `Issue: ${issueRef}`,
    text.includes(prUrl) ? undefined : prUrl,
  ].filter((line): line is string => line !== undefined)
  return missing.length > 0 ? `${text}\n${missing.join('\n')}` : text
}

/** La task del evento (lo que publica `resolve_task`). */
function taskFrom(ctx: PipelineExecutionContext): Task {
  const payload = ctx.event.payload as {
    owner?: string
    repo?: string
    number?: number
    task?: { branch?: string; pr?: { number?: number } }
    pr?: { number?: number }
  }
  const { owner, repo, number } = payload
  if (!owner || !repo || typeof number !== 'number') {
    throw new Error(
      'el evento no trae la task (owner/repo/number): request_slack_review corre sobre una task',
    )
  }
  const prNumber = payload.task?.pr?.number ?? payload.pr?.number
  return {
    owner,
    repo,
    number,
    ...(payload.task?.branch ? { branch: payload.task.branch } : {}),
    ...(typeof prNumber === 'number' ? { prNumber } : {}),
  }
}
