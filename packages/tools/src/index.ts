export * from './contract.js'
export {
  buildToolInstructions,
  executeLoop,
  getAllTools,
  getTool,
  getToolDefinitions,
  getToolsByCategory,
  registerTool,
  resolveAliases,
  resolveTools,
} from './engine.js'
export { setSystemPromptPort } from './ports.js'
export {
  compilePolicy,
  LEGACY_BASH_WHITELIST,
  LEGACY_DEFAULT_POLICY,
  listPresets,
} from './policy.js'
export type { CompilePolicyInput } from './policy.js'
export {
  ALL_PRESETS,
  IMPLEMENTER_PRESET,
  PRESET_BY_ID,
  READER_PRESET,
  REFINER_PRESET,
  RELEASER_PRESET,
  REVIEWER_PRESET,
} from './permission-presets.js'
export type { PermissionPresetDef } from './permission-presets.js'
export { setLoggerFactory } from './logger.js'
export type { Logger, LoggerFactory } from './logger.js'

// Tool categories — imported for their registerTool() side effects, and
// re-exporting whatever public surface each exposes (test/introspection
// helpers, port setters). Importing this package's index registers every
// built-in tool, same as apps/server/src/routes/tools.ts did before the
// move with its 7 separate side-effect imports.
export { setLoadProviderConfig } from './fs/fs.js'
import './fs/fs.js'
import './write/write.js'
import './exec/exec.js'
export { setWorkspaceManagerPort, getWorkspaceManagerPort } from './workspace/workspace.js'
import './workspace/workspace.js'
import './task/task.js'
export { setRepoResolverPort } from './github/tools.js'
export type { GitHubToolContext } from './github/tools.js'
import './github/tools.js'
import './slack/slack.js'
export {
  conversationsHistory,
  conversationsReplies,
  getUserName,
  postMessage,
} from './slack/client.js'
export type { SlackMessage } from './slack/client.js'
export { parseSlackPermalink } from './slack/permalink.js'
