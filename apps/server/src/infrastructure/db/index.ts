// Barrel of repositories + helper of storage-engine selection (SQLite vs a
// static YAML file) for fixed-engine deploys (e.g. a container that only
// runs the refiner agent). `pickRepo` does NOT instantiate anything — it
// only decides which of the two thunks to call; the real `new` still lives
// in composition/container.ts, the only place allowed to do that (see root
// CLAUDE.md, "No instanciar clases concretas fuera de
// composition/container.ts").
export type RepoSource = 'sqlite' | 'yaml'

// Resolution order: the repo-specific env var (e.g. IA_FLOW_AGENT_REPO) if
// set, else the global IA_FLOW_REPO_SOURCE (applies to every dual-source
// repo at once), else default 'sqlite'. Any value that isn't exactly
// 'yaml' falls back to 'sqlite' — fails closed toward current behavior
// instead of surprising with a silent typo.
export function resolveRepoSource(perRepoEnvVar?: string): RepoSource {
  const value = (perRepoEnvVar ? Bun.env[perRepoEnvVar] : undefined) ?? Bun.env.IA_FLOW_REPO_SOURCE
  return value === 'yaml' ? 'yaml' : 'sqlite'
}

/**
 * `preloaded` gana sobre todo lo demás: es un repositorio que el ENTRYPOINT ya
 * construyó porque tenía los datos en la mano, y entonces no hay path que
 * resolver ni env var que consultar. Los repos que nadie precarga (system
 * prompts, statuses, prompts, settings) siguen cayendo a SQLite igual que hoy.
 *
 * Es un parámetro y no una consulta a un singleton a propósito. Antes esto
 * importaba el loader del `runner.yaml`, o sea que el helper genérico de
 * elección de storage conocía el formato de config de un deploy concreto — la
 * flecha al revés, y un service locator de los que el CLAUDE.md prohíbe para
 * código nuevo. Ahora `pickRepo` no sabe que existe un runner: sabe que
 * alguien puede traerle el repositorio ya construido.
 */
export function pickRepo<T>(opts: {
  sqlite: () => T
  yaml: () => T
  preloaded?: T
  envVar?: string
}): T {
  if (opts.preloaded) return opts.preloaded
  return resolveRepoSource(opts.envVar) === 'yaml' ? opts.yaml() : opts.sqlite()
}

export { CONFIG_DIR, getDb } from './database.js'
export { BroadcastingExecutionLogRepository } from './BroadcastingExecutionLogRepository.js'
export { CompositeExecutionLogRepository } from './CompositeExecutionLogRepository.js'
export { RemoteExecutionLogRepository } from './RemoteExecutionLogRepository.js'
export { SourceTaggingExecutionLogRepository } from './SourceTaggingExecutionLogRepository.js'
export { SqliteAgentMemoryRepository } from './sqlite/SqliteAgentMemoryRepository.js'
export { SqliteAgentRepository } from './sqlite/SqliteAgentRepository.js'
export { SqliteEnvVarRepository } from './sqlite/SqliteEnvVarRepository.js'
export { SqliteExecutionLogRepository } from './sqlite/SqliteExecutionLogRepository.js'
export { SqliteGlobalSettingsRepository } from './sqlite/SqliteGlobalSettingsRepository.js'
export { SqliteMcpCatalogRepository } from './sqlite/SqliteMcpCatalogRepository.js'
export { SqliteProjectConfigRepo } from './sqlite/SqliteProjectConfigRepo.js'
export { SqliteProjectRepository } from './sqlite/SqliteProjectRepository.js'
export { SqliteProviderRegistrationRepository } from './sqlite/SqliteProviderRegistrationRepository.js'
export { SqlitePromptRepository } from './sqlite/SqlitePromptRepository.js'
export { SqliteRepoRepository } from './sqlite/SqliteRepoRepository.js'
export { SqliteProcessedEventRepository } from './sqlite/SqliteProcessedEventRepository.js'
export { SqliteActionRepository } from './sqlite/SqliteActionRepository.js'
export { SqliteRuleRepository } from './sqlite/SqliteRuleRepository.js'
export { ProjectScopedRuleRepository } from './ProjectScopedRuleRepository.js'
export { SqliteToolRepository } from './sqlite/SqliteToolRepository.js'
export { SqliteSeenItemRepository } from './sqlite/SqliteSeenItemRepository.js'
export { SqliteRunCheckpointRepository } from './sqlite/SqliteRunCheckpointRepository.js'
export { SqliteAgentAbortRepository } from './sqlite/SqliteAgentAbortRepository.js'
export {
  SqliteRunMessageRepository,
  SqliteWaitRepository,
} from './sqlite/SqliteWaitRepository.js'
export { YamlRuleRepository } from './yaml/YamlRuleRepository.js'
export { SqliteStatusRepository } from './sqlite/SqliteStatusRepository.js'
export { SqliteSystemPromptRepository } from './sqlite/SqliteSystemPromptRepository.js'
export { YamlAgentMemoryRepository } from './yaml/YamlAgentMemoryRepository.js'
export { YamlAgentRepository } from './yaml/YamlAgentRepository.js'
export { YamlGlobalSettingsRepository } from './yaml/YamlGlobalSettingsRepository.js'
export { YamlMcpCatalogRepository } from './yaml/YamlMcpCatalogRepository.js'
export { YamlProjectRepository } from './yaml/YamlProjectRepository.js'
export { YamlPromptRepository } from './yaml/YamlPromptRepository.js'
export { YamlRepoRepository } from './yaml/YamlRepoRepository.js'
export { YamlStatusRepository } from './yaml/YamlStatusRepository.js'
export { YamlSystemPromptRepository } from './yaml/YamlSystemPromptRepository.js'
