export interface IssueItem {
  id: string
  title: string
  description: string
  type: string
  repos: string[]
  status: string
  agentWorking?: boolean
  meta?: Record<string, unknown>  // issueId, issueNumber, projectId, issueBody, etc.
}

export interface ValidationResult {
  ok: boolean
  reason?: string
}

export type BroadcastFn = (msg: object) => void
