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
   * Applies labels to the task (add semantics). Sources that don't model
   * labels natively (e.g. LocalProjectSource) may treat this as a no-op.
   *
   * @deprecated Prefer `addLabels`; kept for the legacy `set_task_labels`
   * tool which historically used add-only semantics.
   */
  setLabels?(task: Task, labels: string[]): Promise<Task>
  /**
   * Adds the given labels to the task. Union with any existing labels;
   * duplicates are collapsed by the source. Returns the task with its
   * `labels` field updated to reflect the merged set.
   */
  addLabels?(task: Task, labels: string[]): Promise<Task>
  /**
   * Removes the given labels from the task. Labels that aren't present are
   * treated according to source semantics (GitHub returns 404 per label;
   * local trims silently). Returns the task with its `labels` field updated
   * to reflect the removal.
   */
  removeLabels?(task: Task, labels: string[]): Promise<Task>
  /**
   * Replaces the task's entire label set with the given list (PUT
   * semantics). Passing an empty array clears every label. Returns the
   * task with its `labels` field set to a copy of the input.
   */
  replaceLabels?(task: Task, labels: string[]): Promise<Task>
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
  /**
   * Fresh read of the task's current Status **bypassing any in-memory or
   * TTL cache** in the adapter. Used by orchestration guards that must not
   * trust stale in-process copies of the task (e.g. deciding whether the
   * prompt already moved the task before applying the default onFinish).
   * Return null if the source doesn't expose a status.
   */
  getCurrentStatus?(task: Task): Promise<string | null>
  /**
   * Devuelve el ID canónico del issue en el source y las coordenadas del repo
   * primario, si el source los conoce (típicamente GitHub). Lo usa el
   * orquestador para auto-crear una linked branch en el Development panel
   * cuando el primer agente con write tools se lanza y `task.branch` está
   * vacío. `null` cuando el source no lo soporta (ej. adapter local).
   */
  getLinkedBranchRef?(task: Task): { issueNodeId: string; owner: string; repoName: string } | null
}
