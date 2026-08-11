import type { Task } from '@ia-flow/shared'

/**
 * Write-side port that adapts task lifecycle operations to the underlying
 * project source (GitHub Projects, local YAML, etc.). Implementations live
 * under `adapters/<source>/transition-manager.ts`.
 */
export interface ITransitionManager {
  applyTransition(task: Task, newStatus: string): Promise<Task>
  saveOutput(task: Task, content: string): Promise<Task>
  setAgentWorking(task: Task, working: boolean): Promise<Task>
  postError?(task: Task, error: string): Promise<void>
  postComment?(task: Task, body: string): Promise<void>
  /** Returns project-level variables available as {{project.*}} in agent prompts. */
  getProjectContext?(): Record<string, string>
  /** Sets one or more project fields (non-status) in a single call. Persists to remote if supported. */
  setFields?(task: Task, fields: Record<string, string>): Promise<Task>
  /**
   * Applies labels to the task. Sources that don't model labels natively
   * (e.g. LocalProjectSource) may treat this as a no-op.
   */
  setLabels?(task: Task, labels: string[]): Promise<Task>
  /**
   * Marks `blockedIssueId` as blocked by `blockingIssueId` (source-native
   * dependency relationship). IDs are opaque to the domain — each adapter
   * decides the format (node ID, numeric ID, etc.).
   */
  markBlockedBy?(task: Task, blockedIssueId: string, blockingIssueId: string): Promise<void>
  /**
   * Returns source-specific context needed by adapter-owned tools (e.g. the
   * GitHub adapter tools use this to reach the current project item). The
   * shape is opaque to the domain — only the adapter's own tools know how
   * to interpret it.
   */
  getSourceToolContext?(): unknown
}
