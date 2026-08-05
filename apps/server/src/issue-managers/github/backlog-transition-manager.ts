import type { Task } from '@ia-flow/shared'
import type { TransitionManager } from '../transition-manager.js'
import type { BroadcastFn } from '../types.js'
import { updateItemStatus, addIssueComment, clearItemWorking, type ProjectMeta } from '../../github/project.js'
import { addLabelsToIssue } from '../../github/labels.js'
import { createLogger } from '../../logger.js'

const log = createLogger('backlog-transition-manager')

interface BacklogOutput {
  fields?: Record<string, string>
  labels?: string[]
  summary?: string
}

function buildComment(parsed: BacklogOutput): string {
  const lines: string[] = ['## 🏷️ Backlog tagger']
  if (parsed.summary) lines.push('', parsed.summary)
  if (parsed.fields && Object.keys(parsed.fields).length) {
    lines.push('', '**Campos asignados:**')
    for (const [k, v] of Object.entries(parsed.fields)) lines.push(`- **${k}**: ${v}`)
  }
  if (parsed.labels?.length) {
    lines.push('', `**Labels:** ${parsed.labels.map((l) => `\`${l}\``).join(', ')}`)
  }
  return lines.join('\n')
}

export class BacklogTransitionManager implements TransitionManager {
  constructor(
    private readonly meta: ProjectMeta,
    private readonly itemId: string,
    private readonly issueId: string,
    private readonly owner: string,
    private readonly repoName: string,
    private readonly issueNumber: number,
    private readonly broadcast: BroadcastFn,
  ) {}

  async applyTransition(task: Task, newStatus: string): Promise<Task> {
    const statusField = this.meta.fields['Status']
    if (statusField) {
      await updateItemStatus(this.meta.projectId, this.itemId, statusField, newStatus)
    }
    log.info({ issueId: this.issueId, newStatus }, 'Backlog item status updated')
    this.broadcast({ type: 'github:transition', issueId: this.issueId, newStatus })
    return { ...task, status: newStatus as Task['status'] }
  }

  async setAgentWorking(task: Task, working: boolean): Promise<Task> {
    const workingField = this.meta.fields['Working']
    if (!workingField) return task
    if (working) {
      await updateItemStatus(this.meta.projectId, this.itemId, workingField, 'Yes')
    } else {
      await clearItemWorking(this.meta.projectId, this.itemId, workingField)
    }
    log.info({ issueId: this.issueId, working }, 'Agent working flag updated')
    return task
  }

  async saveOutput(task: Task, content: string): Promise<Task> {
    let parsed: BacklogOutput = {}
    const trimmed = content.trim()
    if (trimmed.startsWith('{')) {
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        log.warn({ issueId: this.issueId }, 'Backlog output is not valid JSON — posting as comment')
        await addIssueComment(this.issueId, `## 🏷️ Backlog tagger\n\n${content}`)
        return task
      }
    }

    // Set project fields (Priority, Size, Task Type, etc.)
    for (const [fieldName, value] of Object.entries(parsed.fields ?? {})) {
      const field = this.meta.fields[fieldName]
      if (!field) {
        log.warn({ fieldName }, 'Field not found in project meta — skipping')
        continue
      }
      try {
        await updateItemStatus(this.meta.projectId, this.itemId, field, value)
        log.info({ fieldName, value }, 'Project field set')
      } catch (e) {
        log.warn({ fieldName, value, err: e }, 'Could not set project field')
      }
    }

    // Add GitHub labels
    if (parsed.labels?.length) {
      try {
        await addLabelsToIssue(this.owner, this.repoName, this.issueNumber, parsed.labels)
        log.info({ labels: parsed.labels }, 'Labels added to issue')
      } catch (e) {
        log.warn({ labels: parsed.labels, err: e }, 'Could not add labels — labels may not exist in the repo')
      }
    }

    // Post summary comment
    await addIssueComment(this.issueId, buildComment(parsed))

    return task
  }

  async postError(task: Task, error: string): Promise<void> {
    await addIssueComment(
      this.issueId,
      `## ⚠️ Backlog tagger error\n\n\`\`\`\n${error}\n\`\`\`\n\nRevisa el error — el item permanece en Backlog.`,
    )
    log.error({ issueId: this.issueId, error }, 'Backlog tagger error posted')
  }

  async postComment(_task: Task, body: string): Promise<void> {
    await addIssueComment(this.issueId, body)
  }
}
