export * from './contract.js'
export { AnthropicApiProvider, UpstreamAbortError } from './anthropic-api/provider.js'
export type { AnthropicApiProviderDeps } from './anthropic-api/provider.js'
export * from './anthropic-api/auth.js'
export {
  createTerminalBase,
  pexec,
  slugify,
  resolveBaseBranch,
  assertWorktreeBranchMatches,
} from './terminal/base.js'
export type { TerminalBaseDeps } from './terminal/base.js'
export { TmuxClaudeProvider, tmuxSessionHandle } from './terminal/tmux/provider.js'
export type { TmuxClaudeProviderDeps } from './terminal/tmux/provider.js'
export {
  ItermClaudeProvider,
  itermSessionHandle,
  closeItermSession,
} from './terminal/iterm/provider.js'
export type { ItermClaudeProviderDeps } from './terminal/iterm/provider.js'
export { createProviderClassifier } from './provider-classifier.js'
export type { ProviderClassifierInput, ProviderClassifierLog } from './provider-classifier.js'
export { ClaudePrintProvider } from './claude-print/provider.js'
export type { ClaudePrintProviderDeps, ClaudePrintLog } from './claude-print/provider.js'

import { AnthropicApiProvider } from './anthropic-api/provider.js'
import type {
  IAgentProvider,
  LoadProviderConfig,
  ToolExecutionPort,
  WorktreePathResolver,
} from './contract.js'
import { ItermClaudeProvider } from './terminal/iterm/provider.js'
import { TmuxClaudeProvider } from './terminal/tmux/provider.js'

export interface CreateAllProvidersDeps {
  toolExecution: ToolExecutionPort
  loadProviderConfig: LoadProviderConfig
  worktree: WorktreePathResolver
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
  const terminalBase = {
    loadProviderConfig: deps.loadProviderConfig,
    worktree: deps.worktree,
  }
  return {
    anthropicApi: new AnthropicApiProvider({
      toolExecution: deps.toolExecution,
      loadProviderConfig: deps.loadProviderConfig,
      log: deps.log,
      contextLogDir: deps.contextLogDir,
      skipContextLog: deps.skipContextLog,
    }),
    tmuxClaude: new TmuxClaudeProvider({ terminalBase, log: deps.log }),
    itermClaude: new ItermClaudeProvider({ terminalBase, log: deps.log }),
  }
}
