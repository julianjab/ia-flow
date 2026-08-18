import type { Project } from '@ia-flow/shared'
import type { ITaskRepository, ProjectSource } from './contract.js'
import { GitHubProjectSource, invalidateGitHubCache } from './github-polling/source.js'
import { LocalProjectSource } from './local-fs/source.js'

// Registry maps a project row → its read-side source. Resolution reads
// project.source ({ kind, config }). Sources are memoized per (kind, key)
// so repeated calls hit the same instance and share their cache.
//
// Adding a new provider: register its factory + cache-key builder in
// `factories` below. Nothing else here changes.

// A factory turns the project's opaque config blob into a live source
// instance. It also returns a stable cache key so repeated resolutions
// dedupe onto the same instance.
type ProviderKind = string
interface SourceFactory {
  build(project: Project, config: Record<string, unknown>): ProjectSource
  cacheKey(project: Project, config: Record<string, unknown>): string
  invalidate?(config: Record<string, unknown>): void
}

export interface SourceRegistryDeps {
  taskRepo: ITaskRepository
}

export interface SourceRegistry {
  getSourceForProject(project: Project): ProjectSource
  invalidateSourceForProject(project: Project): void
}

export function createSourceRegistry(deps: SourceRegistryDeps): SourceRegistry {
  const factories: Record<ProviderKind, SourceFactory> = {
    github: {
      build: (_p, cfg) => {
        const url = cfg.url
        if (typeof url !== 'string' || !url) {
          throw new Error('GitHub source requires config.url (string)')
        }
        return new GitHubProjectSource(url)
      },
      cacheKey: (_p, cfg) => `github::${String(cfg.url ?? '')}`,
      invalidate: (cfg) => {
        if (typeof cfg.url === 'string') invalidateGitHubCache(cfg.url)
      },
    },
    local: {
      build: () => new LocalProjectSource(deps.taskRepo),
      cacheKey: (p) => `local::${p.id}`,
    },
  }

  // Projects with no source column are treated as local (matches the migration
  // backfill for legacy rows without github_project_url).
  function pickFactory(project: Project): { kind: ProviderKind; factory: SourceFactory } {
    const kind = project.source?.kind ?? 'local'
    const factory = factories[kind]
    if (!factory) throw new Error(`Unknown project source kind: '${kind}'`)
    return { kind, factory }
  }

  const instances = new Map<string, ProjectSource>()

  function getSourceForProject(project: Project): ProjectSource {
    const { factory } = pickFactory(project)
    const config = project.source?.config ?? {}
    const key = factory.cacheKey(project, config)
    let inst = instances.get(key)
    if (!inst) {
      inst = factory.build(project, config)
      instances.set(key, inst)
    }
    return inst
  }

  // Invalidate any cached source + provider-owned caches for a project. Call
  // when project.source changes (e.g. someone edits the URL).
  function invalidateSourceForProject(project: Project): void {
    const { factory } = pickFactory(project)
    const config = project.source?.config ?? {}
    instances.delete(factory.cacheKey(project, config))
    factory.invalidate?.(config)
  }

  return { getSourceForProject, invalidateSourceForProject }
}
