export * from './contract.js'
export { createLogger, setLoggerFactory } from './logger.js'
export type { Logger, LoggerFactory } from './logger.js'

// ─── Dispatch (the "when/how" of driving a ProjectSource) ──────────────────
export { IssueManager } from './dispatch/issue-manager.js'
export { SourceDispatcher, type SourceDispatcherWatchOpts } from './dispatch/source-dispatcher.js'
export {
  pollIntervalMs,
  webhookDebounceMs,
  webhookFallbackMs,
  concurrencyRetryMaxMs,
  CONCURRENCY_RETRY_FLOOR_MS,
} from './dispatch/env.js'
export {
  registerWebhookTarget,
  listWebhookTargets,
  hasWebhookTarget,
  deliverWebhook,
  triggerWebhookTarget,
} from './dispatch/webhook-registry.js'
export type {
  WebhookHint,
  WebhookTarget,
  WebhookTargetStats,
  WebhookDelivery,
} from './dispatch/webhook-registry.js'
export { DivergenceReconciler, reconcileIntervalMs } from './dispatch/divergence-reconciler.js'
export type { DivergenceReconcilerDeps } from './dispatch/divergence-reconciler.js'
export {
  type DaemonMode,
  DAEMON_MODES,
  DEFAULT_DAEMON_MODE,
  parseDaemonMode,
  envDaemonMode,
  resolveDaemonMode,
} from './dispatch/daemon-mode.js'
export {
  type ProjectFilter,
  resolveProjectFilter,
  matchesProjectFilter,
} from './dispatch/project-filter.js'
export { condToOp, evalWhen } from './dispatch/when.js'
export {
  ERROR_COMMENT_MARKER,
  IA_FLOW_MARKER_PREFIX,
  SYSTEM_COMMENT_MARKER,
  USED_COMMENT_MARKER,
  isCommentByAgent,
  selectCommentWindow,
} from './dispatch/comment-window.js'
export type { WindowableComment } from './dispatch/comment-window.js'
export {
  applyMultiValueOps,
  isMultiValueField,
  MULTI_SELECT_DATA_TYPE,
  MULTI_VALUE_FIELD,
} from './dispatch/field-ops.js'
export {
  type CatchUpOptions,
  startupScanEnabled,
  crashRecoveryEnabled,
  resolveCatchUp,
} from './dispatch/catch-up.js'
export { mergeSourceFieldsIntoTask } from './dispatch/merge-source-fields.js'
export {
  pauseProject,
  resumeProject,
  isProjectPaused,
  listPausedProjects,
} from './dispatch/polling-pause.js'
export { createSourceFactory, createDefaultSourceFactory } from './source-factory.js'
export type { SourceFactory, SourceBuilder } from './source-factory.js'

// ─── github-shared (generic GitHub REST/GraphQL — no Project v2 coupling,
// used by both github-project/ and github-issues/) ────────────────────────
export { rest, gql, RateLimitError, type GQLResponse } from './github-shared/client.js'
export { setGitHubCredentials, getGitHubToken } from './github-shared/credentials.js'
export {
  getRateLimit,
  markRateLimited,
  updateFromHeaders,
  onRateLimitChange,
  type RateLimitResource,
} from './github-shared/rate-limit.js'
export {
  fetchConversation,
  postToTarget,
  replyToReviewThread,
  resolveReviewThread,
} from './github-shared/conversation.js'
export { replaceIssueLabels } from './github-shared/labels.js'
export { createLinkedBranch } from './github-shared/linked-branches.js'
export {
  addBlockedBy,
  addIssueComment,
  addSubIssue,
  createIssue,
  fetchIssueComments,
  getBlockingIssues,
  updateIssueBody,
  type IssueComment,
} from './github-shared/issue.js'

// ─── github-project (Projects v2 board — everything below IS board-specific)
export { GitHubProjectSource, collectLabels } from './github-project/source.js'
export { GitHubTaskSource } from './github-project/task-source.js'
export { buildProjectContext } from './github-project/project-context.js'
export type { GitHubToolContext } from './github-project/tool-context.js'
export {
  getProjectMeta,
  removeStatusOptions,
  listProjectItems,
  getProjectItemById,
  mapProjectItemNode,
  createProjectDraftIssue,
  updateProjectDraftIssue,
  deleteProjectItem,
  setProjectTextField,
  updateItemStatus,
  clearItemWorking,
  getItemSingleSelectValue,
  addProjectItem,
  type ProjectMeta,
  type ProjectField,
  type ProjectItem,
} from './github-project/api/project.js'

// ─── github-issues ──────────────────────────────────────────────────────────
export { GitHubIssueSource, type GitHubIssueSourceConfig } from './github-issues/source.js'
export { GitHubIssueTaskSource } from './github-issues/task-source.js'
export { GitHubIssuesApi, type RestIssue } from './github-issues/api/issues-client.js'
export { FieldLabelCodec, type ParsedFieldLabel } from './github-issues/field-label.js'
export {
  StatusLabelCodec,
  WORKING_LABEL,
  isTracked,
  withWorking,
} from './github-issues/status-label.js'

// ─── local-fs ────────────────────────────────────────────────────────────────
export { LocalProjectSource } from './local-fs/source.js'
export { LocalTaskSource } from './local-fs/task-source.js'
export {
  parseBlockedBy,
  addBlockedBy as addLocalBlockedBy,
  addBlocks,
} from './local-fs/blocked-by.js'
