import {
  type CommentTarget,
  DEFAULT_COMMENT_TARGET,
  type PullRequestRef,
  type Task,
  type WorkingMarker,
} from '@ia-flow/shared'
import type { BroadcastFn, PostErrorOptions, TaskSource, TransferResult } from '../contract.js'
import { applyMultiValueOps, isMultiValueField } from '../dispatch/field-ops.js'
import { mergeSourceFieldsIntoTask } from '../dispatch/merge-source-fields.js'
import { postToTarget } from '../github-shared/conversation.js'
import {
  ERROR_COMMENT_MARKER,
  SYSTEM_COMMENT_MARKER,
  addBlockedBy,
  addIssueComment,
  transferIssue,
  updateIssueBody,
} from '../github-shared/issue.js'
import { replaceIssueLabels } from '../github-shared/labels.js'
import { createLogger } from '../logger.js'
import {
  type ProjectMeta,
  clearItemWorking,
  getItemSingleSelectValue,
  updateItemStatus,
} from './api/project.js'
import { buildProjectContext } from './project-context.js'
import type { GitHubToolContext } from './tool-context.js'
import { DEFAULT_WORKING_MARKER } from './working-marker.js'

const log = createLogger('github-task-source')

export class GitHubTaskSource implements TaskSource {
  constructor(
    private readonly meta: ProjectMeta,
    private readonly itemId: string,
    private readonly issueId: string,
    private readonly broadcast: BroadcastFn,
    private readonly repoName?: string,
    private readonly issueNumber?: number,
    /** PRs del issue, capturados al construir el manager (vienen gratis en
     *  `meta.pullRequests` del item). Es lo que deja que `postComment` mande
     *  al PR sin un request extra para resolverlo. */
    private readonly pullRequests: readonly PullRequestRef[] = [],
    /** Cómo marcar/desmarcar "agente trabajando" — lo declara el proyecto en
     *  `source.config.workingMarker` y lo inyecta GitHubProjectSource. `null`
     *  = este board no usa marca y `setAgentWorking` es un no-op. */
    private readonly marker: WorkingMarker | null = DEFAULT_WORKING_MARKER,
  ) {}

  async applyTransition(task: Task, newStatus: string): Promise<Task> {
    const statusField = this.meta.fields['Status']
    if (statusField) {
      await updateItemStatus(this.meta.projectId, this.itemId, statusField, newStatus)
    }
    log.info({ issueId: this.issueId, newStatus }, 'GitHub status updated')
    this.broadcast({ type: 'github:transition', issueId: this.issueId, newStatus })
    return { ...task, status: newStatus as Task['status'] }
  }

  // Escribe la marca declarada por el proyecto. Es el único embudo de las ~10
  // llamadas a `setAgentWorking(false)` que hay repartidas por Agent.ts y las
  // tools complete_task/fail_task — por eso declarar el marker como DATO (y no
  // como un hook `onProcess`) alcanza para cubrir también el camino de vuelta,
  // incluidos cancel y los paths de error.
  async setAgentWorking(task: Task, working: boolean): Promise<Task> {
    const marker = this.marker
    if (!marker) return task
    const value = working ? marker.on : marker.off

    // `Labels` no es una columna del board: su valor son tokens con signo que
    // `setFields` resuelve contra las labels vigentes (y devuelve la task con
    // las nuevas, que es lo que lee el resto del run).
    if (isMultiValueField(marker.field)) {
      if (!value) return task
      const updated = await this.setFields(task, { [marker.field]: value })
      log.info({ issueId: this.issueId, working }, 'Agent working flag updated')
      return updated
    }

    const projectField = Object.entries(this.meta.fields).find(
      ([name]) => name.toLowerCase() === marker.field.toLowerCase(),
    )?.[1]
    // El board no tiene el campo declarado: degradá en silencio en vez de
    // fallar el run. Es lo que hace que `getHealth` pueda reportarlo como
    // warning en vez de pausar el dispatch del proyecto entero.
    if (!projectField) return task
    if (value) {
      await updateItemStatus(this.meta.projectId, this.itemId, projectField, value)
    } else {
      await clearItemWorking(this.meta.projectId, this.itemId, projectField)
    }
    log.info({ issueId: this.issueId, working }, 'Agent working flag updated')
    return task
  }

  async saveOutput(task: Task, content: string): Promise<Task> {
    await updateIssueBody(this.issueId, content)
    log.info({ issueId: this.issueId }, 'Issue body updated')
    return { ...task, description: content }
  }

  // Acá el único canal de error ES el comentario: el issue no tiene campo
  // donde dejar el estado. Por eso `alreadyCommented` corta — si no,
  // `fail_task` (que ya publicó su reporte estructurado por `postComment`)
  // dejaba DOS comentarios por el mismo fallo.
  async postError(task: Task, error: string, opts?: PostErrorOptions): Promise<void> {
    if (opts?.alreadyCommented) {
      log.error({ issueId: this.issueId, error }, 'Run fallido — ya comentado por fail_task')
      return
    }
    await addIssueComment(
      this.issueId,
      `## ⚠️ Agent error\n\n\`\`\`\n${error}\n\`\`\`\n\nRevisa el error y mueve a status anterior para reintentar.\n\n${ERROR_COMMENT_MARKER}`,
    )
    log.error({ issueId: this.issueId, error }, 'Error comment posted')
  }

  async setFields(task: Task, fields: Record<string, string>): Promise<Task> {
    // `Labels` no es una columna del Project (es un built-in del issue, ver
    // GitHubProjectSource.getFields) y es multi-valor: su `value` son tokens
    // con signo que se resuelven contra las labels vigentes, no un valor a
    // asignar. Se separa del resto para que no caiga en `updateItemStatus`,
    // que sólo sabe escribir single-selects del board.
    const plainFields: Record<string, string> = {}
    let multiValueSpec: string | undefined
    for (const [field, value] of Object.entries(fields)) {
      if (isMultiValueField(field)) multiValueSpec = value
      else plainFields[field] = value
    }

    // Un campo que el board no tiene es un ERROR, no un warning.
    //
    // Antes esto logueaba y seguía — pero abajo `mergeSourceFieldsIntoTask`
    // igual escribía el valor en la task EN MEMORIA, así que el agente recibía
    // éxito, el run continuaba y el outcome se daba por aplicado mientras en
    // GitHub no había pasado nada. Un `$set:Repos=…` contra un board sin ese
    // campo se perdía entero y en silencio; el único rastro era un warn que
    // nadie mira. `GitHubProjectSource.setItemField` (el camino de la API) ya
    // tiraba en este caso: los dos caminos de escritura ahora coinciden.
    const missing: string[] = []
    await Promise.all(
      Object.entries(plainFields).map(async ([field, value]) => {
        const projectField = Object.entries(this.meta.fields).find(
          ([name]) => name.toLowerCase() === field.toLowerCase(),
        )?.[1]
        if (!projectField) {
          missing.push(field)
          return
        }
        await updateItemStatus(this.meta.projectId, this.itemId, projectField, value)
        log.info({ issueId: this.issueId, field, value }, 'GitHub project field updated')
      }),
    )
    if (missing.length) {
      throw new Error(
        `El board no tiene ${missing.length === 1 ? 'el campo' : 'los campos'} ${missing
          .map((f) => `'${f}'`)
          .join(', ')} — agregalo al GitHub Project o corregí el nombre en la salida del agente. ` +
          `Campos disponibles: ${Object.keys(this.meta.fields).join(', ') || 'ninguno'}`,
      )
    }

    let updated = mergeSourceFieldsIntoTask(task, plainFields)
    if (multiValueSpec !== undefined) {
      updated = await this.setLabels(
        updated,
        applyMultiValueOps(updated.labels ?? [], multiValueSpec),
      )
    }
    return updated
  }

  /**
   * Mueve el issue a otro repo del mismo owner. Ver `ITaskSource.transferToRepo`
   * para por qué esto es una operación del source y no un campo que se escribe.
   *
   * El item del board NO se toca acá a propósito: GitHub conserva la membresía
   * del issue en sus proyectos al transferirlo, así que la card sigue donde
   * estaba —misma columna, mismos campos— y sólo cambia de qué repo cuelga.
   * Si algún día dejara de conservarla, el síntoma sería la card desapareciendo
   * del board, no un dato inconsistente.
   */
  async transferToRepo(task: Task, targetRepo: string): Promise<TransferResult> {
    if (this.repoName && this.repoName.toLowerCase() === targetRepo.toLowerCase()) {
      throw new Error(`La tarea ya vive en '${targetRepo}'`)
    }
    const issue = await transferIssue(this.issueId, this.meta.owner, targetRepo)
    log.info(
      {
        issueId: this.issueId,
        from: this.repoName,
        to: targetRepo,
        newIssueNumber: issue.number,
      },
      'Issue transferido de repo',
    )
    this.broadcast({ type: 'task:updated', task: { ...task, repos: [targetRepo] } })
    return { repo: targetRepo, issueNumber: issue.number, issueUrl: issue.url }
  }

  async getCurrentStatus(_task: Task): Promise<string | null> {
    return await getItemSingleSelectValue(this.itemId, 'Status')
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
      this.pullRequests,
    )
    log.info({ issueId: this.issueId, ...where }, 'Comentario de agente publicado')
  }

  async markBlockedBy(_task: Task, blockedIssueId: string, blockingIssueId: string): Promise<void> {
    await addBlockedBy(blockedIssueId, blockingIssueId)
    log.info({ blockedIssueId, blockingIssueId }, 'GitHub blocked-by dependency added')
  }

  /** Reemplazo: `labels` pasa a ser el set completo del issue. Primitiva de
   *  bajo nivel — el camino normal para un agente es
   *  `setFields({ Labels: '+a,-b' })`, que resuelve las ops y llama acá. */
  async setLabels(task: Task, labels: string[]): Promise<Task> {
    if (!this.repoName || this.issueNumber == null) {
      throw new Error('GitHubTransitionManager: repoName and issueNumber required to set labels')
    }
    await replaceIssueLabels(this.meta.owner, this.repoName, this.issueNumber, labels)
    log.info({ issueId: this.issueId, labels }, 'GitHub labels applied')
    // Devolver la task con las labels nuevas mantiene coherente el estado en
    // memoria: el resto del run (condiciones `when`, `{{task.labels}}`) lee de
    // acá y no vuelve a consultar la fuente.
    return { ...task, labels }
  }

  getProjectContext(): Record<string, string> {
    return buildProjectContext(this.meta)
  }

  getLinkedBranchRef(_task: Task): { issueNodeId: string; owner: string; repoName: string } | null {
    if (!this.repoName) return null
    return {
      issueNodeId: this.issueId,
      owner: this.meta.owner,
      repoName: this.repoName,
    }
  }

  getSourceToolContext(): GitHubToolContext {
    return {
      owner: this.meta.owner,
      projectId: this.meta.projectId,
      fields: this.meta.fields,
      itemId: this.itemId,
      issueId: this.issueId,
      ...(this.repoName && { repoName: this.repoName }),
      ...(this.issueNumber != null && { issueNumber: this.issueNumber }),
      // NOTE: `repoName` above is the GHToolContext field (used by GH tools
      // like create_github_issue); it is distinct from Task.repoName which was
      // removed from the domain model.
    }
  }
}
