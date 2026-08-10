import type { Task } from '@ia-flow/shared'
import type { GitHubToolContext } from './ITool.js'

export type { GitHubToolContext }

export interface ITransitionManager {
  applyTransition(task: Task, newStatus: string): Promise<Task>
  saveOutput(task: Task, content: string): Promise<Task>
  setAgentWorking(task: Task, working: boolean): Promise<Task>
  postError?(task: Task, error: string): Promise<void>
  postComment?(task: Task, body: string): Promise<void>
  getProjectContext?(): Record<string, string>
  setFields?(task: Task, fields: Record<string, string>): Promise<Task>
  /**
   * Applies labels to the task. Sources that don't model labels natively
   * (e.g. LocalProjectSource) may treat this as a no-op.
   */
  setLabels?(task: Task, labels: string[]): Promise<Task>
  getGitHubToolContext?(): GitHubToolContext
}
