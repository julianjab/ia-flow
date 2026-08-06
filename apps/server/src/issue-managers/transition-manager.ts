import type { Task } from '@ia-flow/shared'
import type { GitHubToolContext } from '../tools/index.js'

export interface TransitionManager {
  applyTransition(task: Task, newStatus: string): Promise<Task>
  saveOutput(task: Task, content: string): Promise<Task>
  setAgentWorking(task: Task, working: boolean): Promise<Task>
  postError?(task: Task, error: string): Promise<void>
  postComment?(task: Task, body: string): Promise<void>
  /** Returns project-level variables available as {{project.*}} in agent prompts. */
  getProjectContext?(): Record<string, string>
  /** Sets one or more project fields (non-status) in a single call. Persists to remote if supported. */
  setFields?(task: Task, fields: Record<string, string>): Promise<Task>
  /** Returns GitHub context for tool use (owner, projectId, fields). */
  getGitHubToolContext?(): GitHubToolContext
}
