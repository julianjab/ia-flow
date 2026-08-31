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
  unregisterTool,
} from './engine.js'
export { setGitTokenPort, setSystemPromptPort } from './ports.js'
export type { GitTokenPort } from './ports.js'
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
export { setAgentMemoryPort, type AgentMemoryPort } from './memory/memory.js'
import './memory/memory.js'
import './wait/pause.js'
import './wait/wait.js'
export { setWaitPort, resolveExpiry, type WaitPort } from './wait/wait.js'
export { setPausePort, TASK_MESSAGE_EVENT, type PausePort } from './wait/pause.js'
export { setToolDescription } from './engine.js'
import './agent/run-agent.js'
export { setRunAgentPort, type RunAgentPort } from './agent/run-agent.js'
export { setRepoResolverPort } from './github/tools.js'
export type { GitHubToolContext } from './github/tools.js'
import './github/tools.js'

// Slack NO está acá: vive en `@ia-flow/slack`, que depende de este paquete y
// registra sus tools con `registerSlackTools()` en vez de con un efecto de
// importar. La flecha va en ese sentido —y no al revés— para que sacar Slack de
// un deploy no obligue a tocar el resto de las tools. Ver packages/slack/CLAUDE.md.
