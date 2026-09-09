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
export type { BashPatternConfig } from './exec/pattern.js'
export { isBashCommandAllowed, matchesBashPattern } from './exec/pattern.js'
// Tool categories — imported for their registerTool() side effects, and
// re-exporting whatever public surface each exposes (test/introspection
// helpers, port setters). Importing this package's index registers every
// built-in tool, same as apps/server/src/routes/tools.ts did before the
// move with its 7 separate side-effect imports.
export { FILE_SIMPLIFIER_ENV } from './fs/fs.js'
export type { Logger, LoggerFactory } from './logger.js'
export { setLoggerFactory } from './logger.js'
export type { CompilePolicyInput } from './policy.js'
export { compilePolicy } from './policy.js'
export type { GitTokenPort } from './ports.js'
export { setGitTokenPort } from './ports.js'

import './fs/fs.js'
import './write/write.js'
import './exec/exec.js'

export { getWorkspaceManagerPort, setWorkspaceManagerPort } from './workspace/workspace.js'

import './workspace/workspace.js'
import './task/submit-output.js'
import './task/task.js'

export { type AgentMemoryPort, setAgentMemoryPort } from './memory/memory.js'

import './memory/memory.js'
import './wait/pause-until.js'
import './wait/wait.js'

export { setToolDescription } from './engine.js'
export { type PausePort, setPausePort, TASK_MESSAGE_EVENT } from './wait/pause-until.js'
export { resolveExpiry, setWaitPort, type WaitPort } from './wait/wait.js'

import './agent/run-agent.js'

export { type RunAgentPort, setRunAgentPort } from './agent/run-agent.js'
export type { GitHubToolContext } from './github/tools.js'
export { setRepoResolverPort } from './github/tools.js'

import './github/tools.js'

// task-read.ts NO se importa por side-effect: sus tools no llaman a
// `registerTool()` a propósito (ver el header del archivo) — sólo se
// exportan para que el asistente de chat las consuma directamente.
export {
  CHAT_ASSISTANT_READ_TOOLS,
  getProjectReadPort,
  getTaskDetail,
  listTasks,
  type ReadOnlyTool,
  searchTasks,
  setProjectReadPort,
} from './task/task-read.js'

// Slack NO está acá: vive en `@ia-flow/slack`, que depende de este paquete y
// registra sus tools con `registerSlackTools()` en vez de con un efecto de
// importar. La flecha va en ese sentido —y no al revés— para que sacar Slack de
// un deploy no obligue a tocar el resto de las tools. Ver packages/slack/CLAUDE.md.

export type { HaikuRequest, HaikuResponse, HaikuTool } from './haiku.js'
// La llamada a Haiku, para los ayudantes que no son del loop de tools. La
// exporta el paquete porque la credencial y el logging ya viven acá: un
// segundo camino a la misma API sería un segundo lugar donde acordarse de
// leer `Bun.env` por llamada.
export { askHaiku, HAIKU_MODEL, haikuAuthHeader } from './haiku.js'
