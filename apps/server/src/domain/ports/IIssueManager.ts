import type { Task } from '@ia-flow/shared'
import type { ITransitionManager } from './ITransitionManager.js'

export interface IssueItem {
  id: string
  title: string
  description: string
  status: string
  type?: string
  repos?: string[]
  issueNumber?: number
  issueUrl?: string
  comments?: Array<{ body: string; created_at: string }>
  fields?: Record<string, string>
  nodeId?: string
  // ia-flow project this item was polled for. Set by the manager (github/
  // local) so the dispatcher/orchestrator can scope statuses & agents.
  projectId?: string
}

export interface ValidationResult {
  ok: boolean
  reason?: string
}

export type Disposable = { dispose(): void }

export interface IIssueManager {
  start(dispatch: (item: IssueItem) => Promise<void>): Disposable
  getTransitionManager(item: IssueItem): ITransitionManager
  validate?(item: IssueItem): Promise<ValidationResult>
}

export function issueItemToTask(item: IssueItem): Task {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    status: item.status,
    type: (item.type as Task['type']) ?? 'functional',
    repos: item.repos ?? [],
    created_at: new Date().toISOString(),
    issueNumber: item.issueNumber,
    issueUrl: item.issueUrl,
    comments: item.comments,
    projectId: item.projectId,
  }
}
