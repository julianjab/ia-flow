export interface IssueItem {
  id: string
  title: string
  description: string
  type: string
  repos: string[]
  status: string
  agentWorking?: boolean
  issueNumber?: number
  issueUrl?: string
  // ia-flow project this item belongs to (stamped by the manager that fetched it).
  projectId?: string
  meta?: Record<string, unknown> // issueId, projectId, issueBody, etc.
}

export interface ValidationResult {
  ok: boolean
  reason?: string
}

export type BroadcastFn = (msg: object) => void
