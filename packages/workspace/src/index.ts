// @ia-flow/workspace — ciclo de vida del terreno donde corre un agente.
//
// Paquete propio (y no un rincón de `@ia-flow/agent-engine`) porque tiene DOS
// consumidores que no comparten nada más: el daemon (`apps/server`) y el
// agent-host remoto (`apps/agent-host`), que necesita clonar y armar su
// propio worktree sin arrastrar el engine de dispatch entero.

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
export { createLogger, type Logger, type LoggerFactory, setLoggerFactory } from './logger.js'
export {
  TerminalWorkspaceProvisioner,
  type WorkspaceProvisioner,
  WorktreeWorkspaceProvisioner,
} from './provisioners.js'
export { BunShellRunner, type ShellResult, type ShellRunner } from './shell.js'
export {
  type CloneableRepo,
  type GetOrCreateOptions,
  type LiveRunsProbe,
  type ResolvedScopes,
  type ResolveScopesContext,
  TaskLockedError,
  WorkspaceManager,
  type WorkspaceTask,
} from './WorkspaceManager.js'
