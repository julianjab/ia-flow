import { parseGithubProjectItemPayload } from '@ia-tools/github-webhook'
import { type Resolution, ResolveAction, taskArgs } from './resolve.js'

/**
 * `github.projects_v2_item` → la card del board detrás del item. Lo que ia-flow saca del re-scan
 * del board, acá sale de este delivery:
 *
 *   created                → issue.created          (la card entró al board)
 *   edited, campo Status   → issue.status_changed   (con `from`/`to`)
 *   edited, otro campo     → projects_v2_item.edited
 *
 * Un cambio de Status produce SÓLO `issue.status_changed`: las reglas de Refine escuchan también
 * `projects_v2_item.edited` y, sin el lock por task de ia-flow, correrían dos veces.
 */
export class ResolveProjectItemAction extends ResolveAction {
  readonly description = 'Resuelve la card del board detrás de un webhook projects_v2_item'

  protected async resolve(raw: Record<string, unknown>): Promise<Resolution> {
    const parsed = parseGithubProjectItemPayload(raw)
    const issue = await this.intake.reader.issueForItem(parsed.itemId)
    if (!issue) return this.skip(`no se pudo leer el item ${parsed.itemId}`)
    const project = this.intake.projectForBoard(issue.board)
    if (!project) return this.skip(`board ${issue.board.owner}#${issue.board.number} no montado`)

    const previous = this.intake.lastStatus.get(parsed.itemId)
    this.intake.lastStatus.set(parsed.itemId, issue.status)
    const target = { owner: issue.owner, repo: issue.repo, number: issue.number }

    if (raw.action === 'created')
      return this.emit(project, taskArgs('issue.created', target, issue))

    if (parsed.fieldName.toLowerCase() === 'status') {
      const to = parsed.to ?? issue.status
      const from = parsed.from ?? previous
      if (from !== undefined && from === to) return this.skip(`Status sin cambio (${to})`)
      const args = taskArgs('issue.status_changed', target, { ...issue, status: to })
      args.extra = { from, to }
      return this.emit(project, args)
    }

    const args = taskArgs('projects_v2_item.edited', target, issue)
    args.extra = { action: raw.action, fieldName: parsed.fieldName }
    return this.emit(project, args)
  }
}
