import type { Project } from '@ia-flow/shared'
import { getDbProject } from '../db.js'
import { GitHubProjectSource, invalidateGitHubCache } from './github-project-source.js'
import { LocalProjectSource } from './local-project-source.js'
import type { ProjectSource } from './types.js'

// Registry maps a project row → its read-side source. Resolution is pure:
// look at project.githubProjectUrl (and later project.settings.manager) to
// decide which impl to instantiate. Sources are memoized per (kind, key) so
// repeated calls hit the same instance and share its cache.
//
// Adding a new provider: add a branch in `resolveConfig` and a corresponding
// case in `getSource`. No route touches this file — routes always go through
// getSourceForProject.

interface ResolvedConfig {
  kind: 'github' | 'local'
  // Stable cache key — url for github, project id for local.
  key: string
  url?: string
}

function resolveConfig(project: Project): ResolvedConfig {
  if (project.githubProjectUrl) {
    return { kind: 'github', key: project.githubProjectUrl, url: project.githubProjectUrl }
  }
  return { kind: 'local', key: project.id }
}

const instances = new Map<string, ProjectSource>()

function instanceKey(cfg: ResolvedConfig): string {
  return `${cfg.kind}::${cfg.key}`
}

function build(cfg: ResolvedConfig): ProjectSource {
  switch (cfg.kind) {
    case 'github':
      if (!cfg.url) throw new Error('GitHub source requires a project URL')
      return new GitHubProjectSource(cfg.url)
    case 'local':
      return new LocalProjectSource()
  }
}

export function getSourceForProject(project: Project): ProjectSource {
  const cfg = resolveConfig(project)
  const key = instanceKey(cfg)
  let inst = instances.get(key)
  if (!inst) {
    inst = build(cfg)
    instances.set(key, inst)
  }
  return inst
}

export function getSourceForProjectId(projectId: string): ProjectSource {
  const project = getDbProject(projectId)
  if (!project) throw new Error(`Project '${projectId}' not found`)
  return getSourceForProject(project)
}

// Invalidate any cached source + provider caches for a project. Call when the
// project's manager config changes (e.g. someone edits githubProjectUrl).
export function invalidateSourceForProject(project: Project): void {
  const cfg = resolveConfig(project)
  instances.delete(instanceKey(cfg))
  if (cfg.kind === 'github' && cfg.url) invalidateGitHubCache(cfg.url)
}
