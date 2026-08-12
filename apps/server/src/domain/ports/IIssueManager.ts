import type { Task } from '@ia-flow/shared'
import type { ITransitionManager } from './ITransitionManager.js'

/**
 * Canonical shape of an item polled from a project source, before it becomes a
 * Task. Populated by ProjectSource.toIssueItem() and consumed by both the
 * PollingIssueManager (loops) and the TaskDispatcher (converts to Task via
 * issueItemToTask below).
 */
export interface IssueItem {
  id: string
  title: string
  description: string
  status: string
  type: string
  repos: string[]
  agentWorking?: boolean
  issueNumber?: number
  issueUrl?: string
  labels?: string[]
  assignees?: string[]
  comments?: Array<{ body: string; created_at: string }>
  fields?: Record<string, string>
  nodeId?: string
  /**
   * Provider-specific opaque metadata (issueId, projectId, issueBody, ...).
   * Consumers outside the source impl treat it as read-only.
   */
  meta?: Record<string, unknown>
  /** ia-flow project this item belongs to (stamped by the manager that fetched it). */
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
  /**
   * Report whether the underlying source is set up for the daemon to work.
   * When present and returns `{ ok: false }`, PollingIssueManager skips poll
   * cycles and TaskDispatcher skips dispatch as a safety net. Absent = ok.
   * Return shape matches ProjectSource.getHealth().
   */
  getHealth?(): Promise<{
    ok: boolean
    missing: Array<{ name: string; purpose: string }>
    warnings: Array<{ name: string; purpose: string }>
    message?: string
  }>
  /**
   * Return unfinished blockers (issues this item depends on that are not yet
   * done). Source-native definition of "finished":
   * - GitHub: issue.state !== 'closed'
   * - Local: blocker task's status !== 'Done' (case-insensitive)
   * Absent implementations behave as "no blockers".
   */
  getBlockers?(item: IssueItem): Promise<Blocker[]>
}

export interface Blocker {
  /** Stable identifier of the blocking issue (source-native). */
  id: string
  /** Short label for logs/UI (e.g. `#42`, task filename). */
  ref?: string
  /** Human-readable title of the blocking issue if the source knows it. */
  title?: string
  /** Source-native status of the blocker (e.g. `open`, `Refine`). */
  status?: string
  /** Clickable link. GitHub: issue URL. Local: `vscode://file/<abs path>`. */
  url?: string
}

export function issueItemToTask(item: IssueItem): Task {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    status: item.status,
    type: (item.type as Task['type']) ?? 'functional',
    repos: item.repos,
    created_at: new Date().toISOString(),
    issueNumber: item.issueNumber,
    issueUrl: item.issueUrl,
    labels: item.labels,
    assignees: item.assignees,
    fields: item.fields,
    comments: item.comments,
    projectId: item.projectId,
  }
}
