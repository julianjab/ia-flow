export * from './contract.js'
export { createLogger, setLoggerFactory } from './logger.js'
export type { Logger, LoggerFactory } from './logger.js'

// ─── Dispatch (the "when/how" of driving a ProjectSource) ──────────────────
export { IssueManager } from './dispatch/issue-manager.js'
export { SourceIssueManager } from './dispatch/source-issue-manager.js'
export { PollingIssueManager, pollIntervalMs } from './dispatch/polling-issue-manager.js'
export {
  WebhookIssueManager,
  webhookDebounceMs,
  webhookFallbackMs,
} from './dispatch/webhook-issue-manager.js'
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
} from './dispatch/webhook-registry.js'
export {
  type DaemonMode,
  DEFAULT_DAEMON_MODE,
  parseDaemonMode,
  envDaemonMode,
  resolveDaemonMode,
} from './dispatch/daemon-mode.js'
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

// ─── github-project ─────────────────────────────────────────────────────────
export { GitHubProjectSource, collectLabels } from './github-project/source.js'
export { GitHubTaskSource } from './github-project/task-source.js'
export { buildProjectContext } from './github-project/project-context.js'
export type { GitHubToolContext } from './github-project/tool-context.js'
export {
  rest,
  gql,
  RateLimitError,
  type GQLResponse,
} from './github-project/api/client.js'
export {
  getRateLimit,
  markRateLimited,
  updateFromHeaders,
  onRateLimitChange,
  type RateLimitResource,
} from './github-project/api/rate-limit.js'
export {
  getProjectMeta,
  removeStatusOptions,
  listProjectItems,
  createProjectDraftIssue,
  updateProjectDraftIssue,
  deleteProjectItem,
  setProjectTextField,
  updateItemStatus,
  clearItemWorking,
  addIssueComment,
  updateIssueBody,
  getItemSingleSelectValue,
  addBlockedBy,
  getBlockingIssues,
  fetchIssueComments,
  addProjectItem,
  createIssue,
  addSubIssue,
  type ProjectMeta,
  type ProjectField,
} from './github-project/api/project.js'
export { replaceIssueLabels } from './github-project/api/labels.js'
export { createLinkedBranch } from './github-project/api/linked-branches.js'

// ─── github-issues ──────────────────────────────────────────────────────────
export { GitHubIssueSource, type GitHubIssueSourceConfig } from './github-issues/source.js'
export { GitHubIssueTaskSource } from './github-issues/task-source.js'
export { GitHubIssuesApi, type RestIssue } from './github-issues/api/issues-client.js'
export {
  StatusLabelCodec,
  WORKING_LABEL,
  isTracked,
  withWorking,
} from './github-issues/status-label.js'

// ─── local-fs ────────────────────────────────────────────────────────────────
export { LocalProjectSource } from './local-fs/source.js'
export { LocalIssueManager, taskToIssueItem } from './local-fs/issue-manager.js'
export { LocalTaskSource } from './local-fs/task-source.js'
export {
  parseBlockedBy,
  addBlockedBy as addLocalBlockedBy,
  addBlocks,
} from './local-fs/blocked-by.js'
