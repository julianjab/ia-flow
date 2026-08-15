// Re-exports the canonical implementation from @ia-flow/agent-engine.
// Extracted there as part of the composable-engine refactor
// (docs/prd/composable-engine-refactor.md, Phase 3).
export {
  WorkspaceManager,
  hasWriteTools,
  branchNameFor,
  worktreePathFor,
  DEFAULT_WORKTREE_BASE,
} from '@ia-flow/agent-engine'
export type {
  ShellResult,
  ShellRunner,
  WorkspaceTask,
  WorkspaceAgentDef,
  ResolvedScopes,
  GetOrCreateOptions,
  ResolveScopesContext,
} from '@ia-flow/agent-engine'
