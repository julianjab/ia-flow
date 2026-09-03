// @ia-flow/workspace — ciclo de vida del terreno donde corre un agente.
//
// Paquete propio (y no un rincón de `@ia-flow/agent-engine`) porque tiene DOS
// consumidores que no comparten nada más: el daemon (`apps/server`) y el
// agent-host remoto (`apps/agent-host`), que necesita clonar y armar su
// propio worktree sin arrastrar el engine de dispatch entero.
export {
  WorkspaceManager,
  TaskLockedError,
  type CloneableRepo,
  type GetOrCreateOptions,
  type LiveRunsProbe,
  type ResolveScopesContext,
  type ResolvedScopes,
  type WorkspaceTask,
} from './WorkspaceManager.js'
export {
  DEFAULT_WORKTREE_BASE,
  FALLBACK_BASE_BRANCH,
  PROTECTED_BRANCHES,
  type WorktreeNameSource,
  branchNameFor,
  legacyWorktreePathFor,
  worktreeNameFor,
  worktreePathFor,
} from './layout.js'
export {
  TerminalWorkspaceProvisioner,
  WorktreeWorkspaceProvisioner,
  type WorkspaceProvisioner,
} from './provisioners.js'
export { BunShellRunner, type ShellResult, type ShellRunner } from './shell.js'
export { createLogger, setLoggerFactory, type Logger, type LoggerFactory } from './logger.js'
