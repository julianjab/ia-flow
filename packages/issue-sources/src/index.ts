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
export { mergeSourceFieldsIntoTask } from './dispatch/merge-source-fields.js'
export {
  pauseProject,
  resumeProject,
  isProjectPaused,
  listPausedProjects,
} from './dispatch/polling-pause.js'

// ─── github-polling ─────────────────────────────────────────────────────────
export {
  GitHubProjectSource,
  invalidateGitHubCache,
  getCachedGitHubMeta,
} from './github-polling/source.js'
export { GitHubTransitionManager } from './github-polling/transition-manager.js'
export { buildProjectContext } from './github-polling/project-context.js'
export type { GitHubToolContext } from './github-polling/tool-context.js'
export {
  rest,
  gql,
  RateLimitError,
  type GQLResponse,
} from './github-polling/api/client.js'
export {
  getRateLimit,
  markRateLimited,
  updateFromHeaders,
  onRateLimitChange,
  type RateLimitResource,
} from './github-polling/api/rate-limit.js'
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
} from './github-polling/api/project.js'
export { addLabelsToIssue } from './github-polling/api/labels.js'
export { createLinkedBranch } from './github-polling/api/linked-branches.js'

// ─── local-fs ────────────────────────────────────────────────────────────────
export { LocalProjectSource } from './local-fs/source.js'
export { LocalIssueManager, taskToIssueItem } from './local-fs/issue-manager.js'
export { LocalTransitionManager } from './local-fs/transition-manager.js'
export {
  parseBlockedBy,
  addBlockedBy as addLocalBlockedBy,
  addBlocks,
} from './local-fs/blocked-by.js'
