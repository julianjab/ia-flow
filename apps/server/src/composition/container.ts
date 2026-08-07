import type { ManagerConfig } from '@ia-flow/shared'
import { AgentOrchestrator } from '../application/AgentOrchestrator.js'
import { TaskDispatcher } from '../application/TaskDispatcher.js'
import type { IBroadcast } from '../domain/ports/IBroadcast.js'
import type { IIssueManager, IssueItem } from '../domain/ports/IIssueManager.js'
import type { IManagerFactory } from '../domain/ports/IManagerFactory.js'
import { SqliteAgentRepository } from '../infrastructure/db/SqliteAgentRepository.js'
import { SqliteEnvVarRepository } from '../infrastructure/db/SqliteEnvVarRepository.js'
import { SqliteProjectConfigRepo } from '../infrastructure/db/SqliteProjectConfigRepo.js'
import { SqlitePromptRepository } from '../infrastructure/db/SqlitePromptRepository.js'
import { SqliteRepoRepository } from '../infrastructure/db/SqliteRepoRepository.js'
import { getDb } from '../infrastructure/db/database.js'
import { GitHubManagerFactory } from '../infrastructure/issue-managers/GitHubManagerFactory.js'
import { LocalManagerFactory } from '../infrastructure/issue-managers/LocalManagerFactory.js'
import { ProviderRegistry } from '../infrastructure/providers/ProviderRegistry.js'
import { ToolRegistry } from '../infrastructure/tools/ToolRegistry.js'

// ─── Broadcast (mutable — wired after WebSocket is ready) ─────────────────

class MutableBroadcast implements IBroadcast {
  private fn: (msg: object) => void = () => {}

  setFn(fn: (msg: object) => void): void {
    this.fn = fn
  }

  send(msg: object): void {
    this.fn(msg)
  }
}

export const broadcast = new MutableBroadcast()

// ─── DB ───────────────────────────────────────────────────────────────────

const db = getDb()

// ─── Repositories ─────────────────────────────────────────────────────────

export const repoRepo = new SqliteRepoRepository(db)
export const configRepo = new SqliteProjectConfigRepo(db)
export const agentRepo = new SqliteAgentRepository(db)
export const envRepo = new SqliteEnvVarRepository(db)
export const promptRepo = new SqlitePromptRepository(db)

// ─── Registries ───────────────────────────────────────────────────────────

export const providerRegistry = new ProviderRegistry()
export const toolRegistry = new ToolRegistry()

// ─── Application ──────────────────────────────────────────────────────────

export const orchestrator = new AgentOrchestrator(
  providerRegistry,
  toolRegistry,
  configRepo,
  repoRepo,
  broadcast,
)

export const dispatcher = new TaskDispatcher(orchestrator, broadcast, configRepo)

// ─── Manager factories ────────────────────────────────────────────────────

export const managerFactories: IManagerFactory[] = [
  new LocalManagerFactory(),
  new GitHubManagerFactory(broadcast),
]

function defaultManagerConfigs(): ManagerConfig[] {
  const configs: ManagerConfig[] = [{ type: 'local' }]
  if (Bun.env.GITHUB_PROJECT_URL) {
    configs.push({ type: 'github', url: Bun.env.GITHUB_PROJECT_URL })
  }
  return configs
}

export async function buildManagers(
  dispatch: (item: IssueItem) => Promise<void>,
): Promise<IIssueManager[]> {
  const config = await configRepo.getConfig()
  const declared: ManagerConfig[] = defaultManagerConfigs()
  return declared.flatMap((cfg) =>
    managerFactories.filter((f) => f.canHandle(cfg)).map((f) => f.create(cfg, dispatch)),
  )
}
