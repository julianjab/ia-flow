import type { Project } from '@ia-flow/shared'
import type { ITaskRepository, ProjectSource } from './contract.js'
import { GitHubIssueSource } from './github-issues/source.js'
import { GitHubProjectSource } from './github-project/source.js'
import { LocalProjectSource } from './local-fs/source.js'

// Generic kind → implementation registry. `add` registers a builder once per
// kind; `get` resolves a project to its source, building + caching one
// instance per (kind, config) so repeated calls share the same instance —
// and with it, whatever `@memoize`d state that instance's methods hold (see
// GitHubProjectSource). `invalidate` just drops the cached instance: the old
// one (and its memoized cache) is orphaned for GC, and the next `get`
// rebuilds fresh. No per-provider cache-invalidation hook needed anymore —
// that lived on the instance, not the registry.
export type SourceBuilder = (project: Project, config: Record<string, unknown>) => ProjectSource

export interface SourceFactory {
  add(kind: string, build: SourceBuilder): void
  get(project: Project): ProjectSource
  invalidate(project: Project): void
}

export function createSourceFactory(): SourceFactory {
  const builders = new Map<string, SourceBuilder>()
  const instances = new Map<string, ProjectSource>()

  // Projects with no source column are treated as local (matches the
  // migration backfill for legacy rows without github_project_url).
  function resolve(project: Project) {
    const kind = project.source?.kind ?? 'local'
    const build = builders.get(kind)
    if (!build) throw new Error(`Unknown project source kind: '${kind}'`)
    const config = project.source?.config ?? {}
    return { kind, config, build, key: `${kind}::${JSON.stringify(config)}` }
  }

  return {
    add(kind, build) {
      builders.set(kind, build)
    },
    get(project) {
      const { key, config, build } = resolve(project)
      let inst = instances.get(key)
      if (!inst) {
        inst = build(project, config)
        instances.set(key, inst)
      }
      return inst
    },
    invalidate(project) {
      instances.delete(resolve(project).key)
    },
  }
}

// Default factory: registers the two providers this package ships. The
// server just wires `taskRepo` and consumes `get`/`invalidate` — no `new` of
// a provider class outside this package.
export function createDefaultSourceFactory(deps: { taskRepo: ITaskRepository }): SourceFactory {
  const factory = createSourceFactory()
  factory.add('github', (_project, config) => {
    const url = config.url
    if (typeof url !== 'string' || !url) {
      throw new Error('GitHub source requires config.url (string)')
    }
    return new GitHubProjectSource(url)
  })
  factory.add('local', () => new LocalProjectSource(deps.taskRepo))
  factory.add('github-issues', (_project, config) => {
    const owner = config.owner
    const repo = config.repo
    const anchorLabel = config.anchorLabel
    if (typeof owner !== 'string' || !owner) {
      throw new Error('github-issues source requires config.owner (string)')
    }
    if (typeof repo !== 'string' || !repo) {
      throw new Error('github-issues source requires config.repo (string)')
    }
    if (typeof anchorLabel !== 'string' || !anchorLabel) {
      throw new Error('github-issues source requires config.anchorLabel (string)')
    }
    return new GitHubIssueSource({ owner, repo, anchorLabel })
  })
  return factory
}
