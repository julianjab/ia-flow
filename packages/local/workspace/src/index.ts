export * from './actions/index.js'
export {
  branchNameFor,
  DEFAULT_WORKTREE_BASE,
  FALLBACK_BASE_BRANCH,
  legacyWorktreePathFor,
  PROTECTED_BRANCHES,
  type WorktreeNameSource,
  worktreeNameFor,
  worktreePathFor,
} from './layout.js'
export { noopLogger, type WorkspaceLogger } from './logger.js'
export {
  type DependencyStatus,
  dependencyNotice,
  LOCKFILES,
  lockfileOf,
  NodeDependencies,
} from './nodeDeps.js'
export { describePublish, type PublishResult } from './publish.js'
export { NodeShellRunner, type ShellResult, type ShellRunner } from './shell.js'
export {
  type CloneableRepo,
  type GetOrCreateOptions,
  type LiveRunsProbe,
  type PreparedWorktree,
  type ResolvedScopes,
  type ResolveScopesContext,
  TaskLockedError,
  WorkspaceManager,
  type WorkspaceTask,
} from './WorkspaceManager.js'
