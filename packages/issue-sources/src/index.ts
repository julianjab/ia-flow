export * from './contract.js'
export {
  type CatchUpOptions,
  crashRecoveryEnabled,
  resolveCatchUp,
  startupScanEnabled,
} from './dispatch/catch-up.js'
export type { RenderableComment, WindowableComment } from './dispatch/comment-window.js'
export {
  ERROR_COMMENT_MARKER,
  IA_FLOW_MARKER_PREFIX,
  isCommentByAgent,
  renderConversationWindow,
  SYSTEM_COMMENT_MARKER,
  selectCommentWindow,
  USED_COMMENT_MARKER,
} from './dispatch/comment-window.js'
export {
  DAEMON_MODES,
  type DaemonMode,
  DEFAULT_DAEMON_MODE,
  envDaemonMode,
  parseDaemonMode,
  resolveDaemonMode,
} from './dispatch/daemon-mode.js'
export type { DivergenceReconcilerDeps } from './dispatch/divergence-reconciler.js'
export { DivergenceReconciler, reconcileIntervalMs } from './dispatch/divergence-reconciler.js'
export {
  CONCURRENCY_RETRY_FLOOR_MS,
  concurrencyRetryMaxMs,
  DISPATCH_CONFIG_VARS,
  pollIntervalMs,
  webhookDebounceMs,
  webhookFallbackMs,
} from './dispatch/env.js'
export {
  applyMultiValueOps,
  isMultiValueField,
  MULTI_SELECT_DATA_TYPE,
  MULTI_VALUE_FIELD,
} from './dispatch/field-ops.js'
// ─── Dispatch (the "when/how" of driving a ProjectSource) ──────────────────
export { IssueManager } from './dispatch/issue-manager.js'
export { mergeSourceFieldsIntoTask } from './dispatch/merge-source-fields.js'
export {
  isProjectPaused,
  listPausedProjects,
  pauseProject,
  resumeProject,
} from './dispatch/polling-pause.js'
export {
  matchesProjectFilter,
  type ProjectFilter,
  resolveProjectFilter,
} from './dispatch/project-filter.js'
export { SourceDispatcher, type SourceDispatcherWatchOpts } from './dispatch/source-dispatcher.js'
export type {
  WebhookDelivery,
  WebhookHint,
  WebhookTarget,
  WebhookTargetStats,
} from './dispatch/webhook-registry.js'
export {
  deliverWebhook,
  hasWebhookTarget,
  listWebhookTargets,
  registerWebhookTarget,
  triggerWebhookTarget,
} from './dispatch/webhook-registry.js'
export { condToOp, evalWhen } from './dispatch/when.js'
// ─── github-hybrid (issues + project, compuesto) ──────────────────────────────
export { GithubHybridSource } from './github-hybrid/source.js'
export { GitHubIssuesApi, type RestIssue } from './github-issues/api/issues-client.js'
export { FieldLabelCodec, type ParsedFieldLabel } from './github-issues/field-label.js'
// ─── github-issues ──────────────────────────────────────────────────────────
export { GitHubIssueSource, type GitHubIssueSourceConfig } from './github-issues/source.js'
export {
  isTracked,
  StatusLabelCodec,
  WORKING_LABEL,
  withWorking,
} from './github-issues/status-label.js'
export { GitHubIssueTaskSource } from './github-issues/task-source.js'
export {
  addProjectItem,
  clearItemWorking,
  createProjectDraftIssue,
  deleteProjectItem,
  getItemSingleSelectValue,
  getProjectItemById,
  getProjectMeta,
  listProjectItems,
  mapProjectItemNode,
  type ProjectField,
  type ProjectItem,
  type ProjectMeta,
  removeStatusOptions,
  setProjectTextField,
  updateItemStatus,
  updateProjectDraftIssue,
} from './github-project/api/project.js'
export { buildProjectContext } from './github-project/project-context.js'
export {
  DEFAULT_SLACK_THREAD_FIELD,
  parseSlackThreadField,
  readSlackThreadField,
} from './github-project/slack-thread-field.js'
// ─── github-project (Projects v2 board — everything below IS board-specific)
export { collectLabels, GitHubProjectSource } from './github-project/source.js'
export { GitHubTaskSource } from './github-project/task-source.js'
export type { GitHubToolContext } from './github-project/tool-context.js'
export {
  DEFAULT_WORKING_MARKER,
  isMarkedWorking,
  parseWorkingMarker,
} from './github-project/working-marker.js'
// ─── github-shared (generic GitHub REST/GraphQL — no Project v2 coupling,
// used by both github-project/ and github-issues/) ────────────────────────
export {
  GitHubGraphQLError,
  type GQLError,
  type GQLResponse,
  gql,
  isNodeNotFoundError,
  RateLimitError,
  rest,
} from './github-shared/client.js'
export {
  fetchConversation,
  postToTarget,
  type ReactionName,
  reactToComment,
  replyToReviewThread,
  resolveReviewThread,
} from './github-shared/conversation.js'
export {
  describeGitHubCredentials,
  getGitHubToken,
  setGitHubCredentials,
} from './github-shared/credentials.js'
export {
  branchTreeUrl,
  fetchPullRequestDiff,
  isCiFinished,
  openPullRequests,
  PR_DIFF_MAX_CHARS,
} from './github-shared/dev-links.js'
export {
  addBlockedBy,
  addIssueComment,
  addSubIssue,
  createIssue,
  fetchIssueComments,
  getBlockingIssues,
  type IssueComment,
  listSubIssues,
  updateIssueBody,
} from './github-shared/issue.js'
export { replaceIssueLabels } from './github-shared/labels.js'
export { createLinkedBranch } from './github-shared/linked-branches.js'
export {
  getPullRequestBody,
  readSlackThreadUrlFromPr,
  saveSlackThreadUrlInPr,
  updatePullRequestBody,
} from './github-shared/pull-request.js'
export {
  getRateLimit,
  markRateLimited,
  onRateLimitChange,
  type RateLimitResource,
  updateFromHeaders,
} from './github-shared/rate-limit.js'
export {
  extractSlackThreadUrl,
  preserveSlackSection,
  stripSlackSection,
  upsertSlackSection,
} from './github-shared/slack-section.js'
export {
  addBlockedBy as addLocalBlockedBy,
  addBlocks,
  parseBlockedBy,
} from './local-fs/blocked-by.js'
// ─── local-fs ────────────────────────────────────────────────────────────────
export { LocalProjectSource } from './local-fs/source.js'
export { LocalTaskSource } from './local-fs/task-source.js'
export type { Logger, LoggerFactory } from './logger.js'
export { createLogger, setLoggerFactory } from './logger.js'
export type { SourceBuilder, SourceFactory } from './source-factory.js'
export { createDefaultSourceFactory, createSourceFactory } from './source-factory.js'
