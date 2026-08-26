export * from './contract.js'
export * from './admission.js'
export { AnthropicApiProvider, UpstreamAbortError } from './anthropic-api/provider.js'
export type { AnthropicApiProviderDeps } from './anthropic-api/provider.js'
export * from './anthropic-api/auth.js'
export { createTerminalBase, pexec, slugify, resolveBaseBranch } from './terminal/base.js'
export type { TerminalBaseDeps } from './terminal/base.js'
export { TmuxClaudeProvider, tmuxSessionHandle, tmuxLiveness } from './terminal/tmux/provider.js'
export type { TmuxClaudeProviderDeps } from './terminal/tmux/provider.js'
export {
  ItermClaudeProvider,
  itermSessionHandle,
  itermLiveness,
  closeItermSession,
} from './terminal/iterm/provider.js'
export type { ItermClaudeProviderDeps } from './terminal/iterm/provider.js'
export { createProviderClassifier } from './provider-classifier.js'
export type { ProviderClassifierInput, ProviderClassifierLog } from './provider-classifier.js'
export { createAgentClassifier } from './agent-classifier.js'
export type {
  AgentClassifier,
  AgentClassifierInput,
  AgentClassifierLog,
} from './agent-classifier.js'
export { ClaudePrintProvider } from './claude-print/provider.js'
export type { ClaudePrintProviderDeps, ClaudePrintLog } from './claude-print/provider.js'

import { AnthropicApiProvider } from './anthropic-api/provider.js'
import type {
  IAgentProvider,
  LoadProviderConfig,
  ToolExecutionPort,
  WorkspaceProvisionerPort,
} from './contract.js'
import { ItermClaudeProvider } from './terminal/iterm/provider.js'
import { TmuxClaudeProvider } from './terminal/tmux/provider.js'

export interface CreateAllProvidersDeps {
  toolExecution: ToolExecutionPort
  loadProviderConfig: LoadProviderConfig
  /** Prepara el terreno de los providers sync (worktree + scopes). */
  syncWorkspace?: WorkspaceProvisionerPort
  /** Prepara el terreno de los providers de terminal (obedece `workflow`). */
  terminalWorkspace?: WorkspaceProvisionerPort
  log: {
    info: (obj: object, msg?: string) => void
    debug: (obj: object, msg?: string) => void
    warn: (obj: object, msg?: string) => void
    error: (obj: object, msg?: string) => void
  }
  /** See `AnthropicApiProviderDeps.contextLogDir` / `.skipContextLog`. */
  contextLogDir?: string
  skipContextLog?: boolean
}

/** Convenience wiring for the three built-in providers, given the ports the
 *  host (apps/server's composition/container.ts) already has concrete
 *  implementations for. */
export function createAllProviders(deps: CreateAllProvidersDeps): {
  anthropicApi: IAgentProvider
  tmuxClaude: IAgentProvider
  itermClaude: IAgentProvider
} {
  const terminalBase = { loadProviderConfig: deps.loadProviderConfig }
  const workspace = deps.terminalWorkspace
  return {
    anthropicApi: new AnthropicApiProvider({
      toolExecution: deps.toolExecution,
      loadProviderConfig: deps.loadProviderConfig,
      workspace: deps.syncWorkspace,
      log: deps.log,
      contextLogDir: deps.contextLogDir,
      skipContextLog: deps.skipContextLog,
    }),
    tmuxClaude: new TmuxClaudeProvider({ terminalBase, workspace, log: deps.log }),
    itermClaude: new ItermClaudeProvider({ terminalBase, workspace, log: deps.log }),
  }
}
