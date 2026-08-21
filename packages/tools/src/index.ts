export * from './contract.js'
export {
  executeLoop,
  getAllTools,
  getTool,
  getToolDefinitions,
  registerTool,
  resolveAliases,
  resolveExecutableTool,
  resolveTools,
} from './engine.js'
export { setSystemPromptPort } from './ports.js'
export { compilePolicy } from './policy.js'
export type { CompilePolicyInput } from './policy.js'
export { isBashCommandAllowed, matchesBashPattern } from './exec/pattern.js'
export type { BashPatternConfig } from './exec/pattern.js'
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
