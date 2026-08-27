import {
  type CommentTarget,
  DEFAULT_COMMENT_TARGET,
  type PullRequestRef,
  type Task,
} from '@ia-flow/shared'
import type { BroadcastFn, IssueItem, PostErrorOptions, TaskSource } from '../contract.js'
import { applyMultiValueOps, isMultiValueField } from '../dispatch/field-ops.js'
import { mergeSourceFieldsIntoTask } from '../dispatch/merge-source-fields.js'
import type { GitHubToolContext } from '../github-project/tool-context.js'
import { postToTarget } from '../github-shared/conversation.js'
import { ERROR_COMMENT_MARKER, SYSTEM_COMMENT_MARKER } from '../github-shared/issue.js'
import { createLogger } from '../logger.js'
import type { GitHubIssuesApi } from './api/issues-client.js'
import { FieldLabelCodec } from './field-label.js'
import type { GitHubIssueSourceConfig } from './source.js'
import { StatusLabelCodec, WORKING_LABEL, withWorking } from './status-label.js'

const log = createLogger('github-issue-task-source')

/**
 * Write side for GitHubIssueSource — sibling of GitHubTaskSource
 * (github-project/task-source.ts), same shape, but every "field write" is a
 * label replace instead of a Project item-field mutation.
 */
export class GitHubIssueTaskSource implements TaskSource {
  constructor(
    private readonly config: GitHubIssueSourceConfig,
    private readonly api: GitHubIssuesApi,
    private readonly statusLabels: StatusLabelCodec,
    private readonly fieldLabels: FieldLabelCodec,
    private readonly item: IssueItem,
    private readonly broadcast: BroadcastFn,
  ) {}

  private get issueNumber(): number {
    const n = this.item.issueNumber
    if (n == null) throw new Error(`Item ${this.item.id} missing issueNumber`)
    return n
  }

  private get issueId(): string {
    const id = this.item.meta?.issueId as string | undefined
    if (!id) throw new Error(`Item ${this.item.id} missing meta.issueId`)
    return id
  }

  /**
   * Every write below does a full-set label replace, so it MUST start from
   * the issue's current labels, not the item snapshot handed to this
   * instance at dispatch time (from a cache with up to a 60s TTL — see
   * GitHubIssueSource.fetchItems). A stale snapshot would silently drop any
   * label a human, CI, or another agent added to the issue in the meantime.
   * GitHubTaskSource (Project-based) has no equivalent risk: there, status
   * is a board field, not a label PUT that replaces the whole set.
   */
  private async freshLabels(): Promise<string[]> {
    const issue = await this.api.getByNumber(this.config.owner, this.config.repo, this.issueNumber)
    return issue?.labels ?? this.item.labels ?? []
  }

  private async persistLabels(next: string[]): Promise<void> {
    await this.api.replaceLabels(this.config.owner, this.config.repo, this.issueNumber, next)
  }

  async applyTransition(task: Task, newStatus: string): Promise<Task> {
    const next = this.statusLabels.withStatus(await this.freshLabels(), newStatus)
    await this.persistLabels(next)
    log.info({ issueId: this.issueId, newStatus }, 'GitHub issue status label updated')
    this.broadcast({ type: 'github-issue:transition', issueId: this.issueId, newStatus })
    return { ...task, status: newStatus as Task['status'], labels: next }
  }

  async setAgentWorking(task: Task, working: boolean): Promise<Task> {
    const next = withWorking(await this.freshLabels(), working)
    await this.persistLabels(next)
    log.info({ issueId: this.issueId, working }, 'Agent working label updated')
    return { ...task, labels: next }
  }

  async saveOutput(task: Task, content: string): Promise<Task> {
    await this.api.updateBody(this.issueId, content)
    log.info({ issueId: this.issueId }, 'Issue body updated')
    return { ...task, description: content }
  }

  // Acá el único canal de error ES el comentario: el issue no tiene campo
  // donde dejar el estado. Por eso `alreadyCommented` corta — si no,
  // `fail_task` (que ya publicó su reporte estructurado por `postComment`)
  // dejaba DOS comentarios por el mismo fallo.
  async postError(_task: Task, error: string, opts?: PostErrorOptions): Promise<void> {
    if (opts?.alreadyCommented) {
      log.error({ issueId: this.issueId, error }, 'Run fallido — ya comentado por fail_task')
      return
    }
    await this.api.addComment(
      this.issueId,
      `## ⚠️ Agent error\n\n\`\`\`\n${error}\n\`\`\`\n\nRevisa el error y mueve a status anterior para reintentar.\n\n${ERROR_COMMENT_MARKER}`,
    )
    log.error({ issueId: this.issueId, error }, 'Error comment posted')
  }

  // Tagged with SYSTEM_COMMENT_MARKER: marca "lo escribió un agente, no un
  // humano". Cubre complete_task/fail_task (vía ITaskSource.postComment) y
  // add_task_comment (packages/tools/src/task/task.ts), que funnelan todos
  // por acá. NO se descarta de `{{task.comments}}` — es el handoff del
  // pipeline; lo que se acota es a los posteriores al último comentario del
  // agente que corre (selectCommentWindow, dispatch/comment-window.ts).
  async postComment(_task: Task, body: string, target?: CommentTarget): Promise<void> {
    const where = await postToTarget(
      this.issueId,
      `${body}\n\n${SYSTEM_COMMENT_MARKER}`,
      target ?? DEFAULT_COMMENT_TARGET,
      this.item.meta?.pullRequests as PullRequestRef[] | undefined,
    )
    log.info({ issueId: this.issueId, ...where }, 'Comentario de agente publicado')
  }

  /** Reemplazo: `labels` pasa a ser el set completo del issue, salvo el
   *  bookkeeping que `protectBookkeeping` preserva. Primitiva de bajo nivel:
   *  el camino normal para un agente es `setFields({ Labels: '+a,-b' })`. */
  async setLabels(task: Task, labels: string[]): Promise<Task> {
    const fresh = await this.freshLabels()
    const finalLabels = this.protectBookkeeping(labels, fresh)
    await this.persistLabels(finalLabels)
    log.info({ issueId: this.issueId, labels: finalLabels }, 'GitHub labels applied')
    return { ...task, labels: finalLabels }
  }

  /**
   * Re-añade el bookkeeping propio de este source que un reemplazo total
   * (`Labels==algo`) habría borrado: el `anchorLabel` (si el proyecto tiene
   * una — es opcional, ver GitHubIssueSourceConfig), el `status:*` vigente,
   * `WORKING_LABEL` y cualquier `field:*`. En GitHubProjectSource ese
   * equivalente (Status/Working/campos custom) vive en campos del Project,
   * fuera del alcance de las labels; acá viven en labels, así que hay que
   * blindarlos a mano: sin esto, un reemplazo disparado *durante* el propio
   * run del agente borraría el anchor (el issue desaparece del engine sin
   * forma de recuperarlo desde la app), el working flag (el próximo scan ve
   * `working: false` y despacha un segundo agente sobre la misma task), o
   * cualquier `field:*` escrito por `setFields`.
   *
   * Las operaciones `+`/`-` no necesitan esta red — sólo tocan lo que
   * nombran — pero pasar siempre por acá deja una sola regla que auditar.
   */
  private protectBookkeeping(next: string[], fresh: string[]): string[] {
    const out = new Set(next)
    // Sin ancla no hay nada que blindar acá: el issue no depende de una label
    // para seguir siendo visible al scan.
    if (this.config.anchorLabel) out.add(this.config.anchorLabel)
    if (fresh.includes(WORKING_LABEL)) out.add(WORKING_LABEL)
    const currentStatus = this.statusLabels.statusFromLabels(fresh)
    if (currentStatus && this.statusLabels.statusFromLabels([...out]) === '') {
      out.add(this.statusLabels.labelFor(currentStatus))
    }
    const nextFieldNames = new Set(
      [...out].map((l) => this.fieldLabels.parse(l)?.name.toLowerCase()).filter(Boolean),
    )
    for (const label of fresh) {
      const parsed = this.fieldLabels.parse(label)
      if (parsed && !nextFieldNames.has(parsed.name.toLowerCase())) out.add(label)
    }
    return [...out]
  }

  /**
   * GitHub issues have no native custom-field concept — that's a Projects v2
   * board column — so `Status` and every other field name persist as a
   * label: `Status` routes through the same `status:*` mutation
   * `applyTransition` uses (mirrors how `GitHubTaskSource.setFields`
   * resolves "Status" to the Project's Status field and performs the
   * identical `updateItemStatus` call `applyTransition` does there); any
   * other field persists as a `field:<name>=<value>` label via
   * `FieldLabelCodec` — see field-label.ts for why that only fits short,
   * enum-like values, not free text.
   *
   * All mutations batch into ONE `freshLabels()` read + ONE `persistLabels`
   * write, not one round-trip per field — `applyTransition`/label helpers
   * used individually would each do their own fetch-then-replace, racing
   * each other if `fields` has more than one entry.
   *
   * Defining this (instead of leaving it `undefined`, which `ITaskSource`
   * allows since `setFields` is optional) also fixes an LSP gap: the
   * `set_task_field` tool special-cases a missing `setFields` with a hard
   * `throw` (`packages/tools/src/task/task.ts`), while `outcomes.ts`'s
   * `$set:` handler quietly falls back to an in-memory-only merge for the
   * same gap — same underlying fact, two different behaviors depending on
   * which caller you went through.
   */
  async setFields(task: Task, fields: Record<string, string>): Promise<Task> {
    const fresh = await this.freshLabels()
    let labels = fresh
    let status: string | undefined
    const plainFields: Record<string, string> = {}
    for (const [field, value] of Object.entries(fields)) {
      if (isMultiValueField(field)) {
        // Campo multi-valor: `value` son tokens con signo, no un valor a
        // asignar. Se resuelven contra las labels vigentes y el resultado
        // entra al mismo batch de persistLabels que el resto.
        labels = this.protectBookkeeping(applyMultiValueOps(labels, value), fresh)
        continue
      }
      plainFields[field] = value
      if (field.toLowerCase() === 'status') {
        status = value
        labels = this.statusLabels.withStatus(labels, value)
      } else {
        // labelFor() itself truncates rather than throwing — a too-long
        // value must not fail this write (it batches with an unrelated
        // Status change into one persistLabels call below). Just warn.
        if (this.fieldLabels.wouldTruncate(field, value)) {
          log.warn(
            { issueId: this.issueId, field, valueLength: value.length },
            'Field value too long for a GitHub label — truncated to fit',
          )
        }
        labels = this.fieldLabels.withField(labels, field, value)
      }
    }
    await this.persistLabels(labels)
    if (status !== undefined) {
      log.info({ issueId: this.issueId, newStatus: status }, 'GitHub issue status label updated')
      this.broadcast({ type: 'github-issue:transition', issueId: this.issueId, newStatus: status })
    } else {
      log.info({ issueId: this.issueId, fields }, 'GitHub issue field label(s) updated')
    }
    const withLabels: Task = {
      ...task,
      labels,
      ...(status !== undefined ? { status: status as Task['status'] } : {}),
    }
    // `plainFields`, no `fields`: el spec de un campo multi-valor (`+a,-b`)
    // es una operación, no un valor — mergearlo dejaría `task.fields.Labels`
    // con los tokens en vez del set resuelto, que ya viaja en `task.labels`.
    return mergeSourceFieldsIntoTask(withLabels, plainFields)
  }

  async getCurrentStatus(_task: Task): Promise<string | null> {
    const issue = await this.api.getByNumber(this.config.owner, this.config.repo, this.issueNumber)
    if (!issue) return null
    return this.statusLabels.statusFromLabels(issue.labels) || null
  }

  async markBlockedBy(_task: Task, blockedIssueId: string, blockingIssueId: string): Promise<void> {
    await this.api.addBlockedBy(blockedIssueId, blockingIssueId)
    log.info({ blockedIssueId, blockingIssueId }, 'GitHub blocked-by dependency added')
  }

  getLinkedBranchRef(_task: Task): { issueNodeId: string; owner: string; repoName: string } | null {
    return {
      issueNodeId: this.issueId,
      owner: this.config.owner,
      repoName: this.config.repo,
    }
  }

  /**
   * No Projects v2 board here — `projectId` stays unset, which is exactly
   * what `GitHubToolContext.projectId` being optional is for. `create_github_issue`
   * / `add_sub_issue` only need `owner` (+ repo/issue identity for linking);
   * `add_to_project` is the one tool that genuinely needs a board, and it
   * fails loudly on its own when `projectId` is missing — this source simply
   * shouldn't list that tool in an agent's `tools[]`.
   */
  getSourceToolContext(): GitHubToolContext {
    return {
      owner: this.config.owner,
      fields: {},
      issueId: this.issueId,
      repoName: this.config.repo,
      issueNumber: this.issueNumber,
    }
  }
}
