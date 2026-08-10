// Re-exports the canonical IssueItem shape from the domain port so infra
// modules (polling manager, project sources, transition managers) share the
// same type as the application layer (TaskDispatcher). Historically these
// were two separate interfaces that drifted; keep them unified.
export type { IssueItem, ValidationResult } from '../domain/ports/IIssueManager.js'

export type BroadcastFn = (msg: object) => void
