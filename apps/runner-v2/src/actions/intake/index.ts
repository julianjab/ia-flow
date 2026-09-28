/**
 * Los pasos de las pipelines de entrada (`../../intake.ts`): cada `Resolve*Action` completa un
 * webhook crudo con lo que el agente necesita, y `TaskContextReader` carga comentarios, CI, PR y
 * blockers de la task.
 */

export { ResolveCiRunAction } from './ResolveCiRunAction.js'
export { ResolveIssueCommentAction } from './ResolveIssueCommentAction.js'
export { ResolveProjectItemAction } from './ResolveProjectItemAction.js'
export { ResolvePullRequestAction } from './ResolvePullRequestAction.js'
export {
  type IntakeContext,
  type IntakeProject,
  linkedIssue,
  type Resolution,
  ResolveAction,
} from './resolve.js'
export {
  GithubTaskContextReader,
  type TaskContext,
  type TaskContextQuery,
  type TaskContextReader,
} from './task-context.js'
