import type { Project } from '@ia-flow/shared'
import type { ITaskRepository, ProjectSource } from './contract.js'
import { GitHubIssueSource } from './github-issues/source.js'
import { parseSlackThreadField } from './github-project/slack-thread-field.js'
import { GitHubProjectSource } from './github-project/source.js'
import { parseWorkingMarker } from './github-project/working-marker.js'
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
  /** Registers `build` under `kind`. `aliasOf` marks `kind` as a deprecated
   * spelling of an already-registered kind: sigue resolviendo (las filas ya
   * persistidas con ese nombre no se rompen), pero `listKinds()` deja de
   * ofrecerlo y `get()` cachea bajo el nombre canónico — así los dos nombres
   * de la MISMA config comparten instancia (y su cache `@memoize`) en vez de
   * abrir dos. Renombrar un kind es esto: registrar el nombre bueno y dejar
   * el viejo como alias, sin migración obligatoria en el mismo deploy. */
  add(kind: string, build: SourceBuilder, opts?: { aliasOf?: string }): void
  get(project: Project): ProjectSource
  invalidate(project: Project): void
  /** Build the source for `project` and let the builder's error escape when
   * its config is incomplete — WITHOUT caching the instance. Validating at an
   * API border shouldn't leave a live source in the registry for a row that
   * may never be persisted, nor depend on being called before `invalidate`. */
  validate(project: Project): void
  /** Kinds with a registered builder, in registration order — e.g. for a
   * project-creation form to offer exactly what this factory can build,
   * instead of a hardcoded list that drifts from what's actually wired. */
  listKinds(): string[]
}

export function createSourceFactory(): SourceFactory {
  const builders = new Map<string, SourceBuilder>()
  const instances = new Map<string, ProjectSource>()
  // kind deprecado → kind canónico. Sólo afecta a `listKinds` (qué se ofrece)
  // y a la clave de cache (que dos nombres no dupliquen instancia).
  const aliases = new Map<string, string>()

  // Projects with no source column are treated as local (matches the
  // migration backfill for legacy rows without github_project_url).
  function resolve(project: Project) {
    const kind = project.source?.kind ?? 'local'
    const build = builders.get(kind)
    if (!build) throw new Error(`Unknown project source kind: '${kind}'`)
    const config = project.source?.config ?? {}
    const canonical = aliases.get(kind) ?? kind
    return { kind, config, build, key: `${canonical}::${JSON.stringify(config)}` }
  }

  return {
    add(kind, build, opts) {
      builders.set(kind, build)
      if (opts?.aliasOf) aliases.set(kind, opts.aliasOf)
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
    validate(project) {
      const { config, build } = resolve(project)
      build(project, config)
    },
    listKinds() {
      return [...builders.keys()].filter((kind) => !aliases.has(kind))
    },
  }
}

// Default factory: registers the two providers this package ships. The
// server just wires `taskRepo` and consumes `get`/`invalidate` — no `new` of
// a provider class outside this package.
export function createDefaultSourceFactory(deps: { taskRepo: ITaskRepository }): SourceFactory {
  const factory = createSourceFactory()
  const buildGitHubProjects: SourceBuilder = (_project, config) => {
    const url = config.url
    if (typeof url !== 'string' || !url) {
      throw new Error('GitHub Projects source requires config.url (string)')
    }
    // Valida en el borde: un `workingMarker` (o un `slackThreadField`) mal
    // escrito falla al guardar el proyecto (400 vía SourceFactory.validate) o
    // al bootear el runner, no en el primer dispatch.
    return new GitHubProjectSource(
      url,
      parseWorkingMarker(config.workingMarker),
      parseSlackThreadField(config.slackThreadField),
    )
  }
  factory.add('github-projects', buildGitHubProjects)
  factory.add('local', () => new LocalProjectSource(deps.taskRepo))
  // Alias deprecado: así se llamaba el kind de Projects v2 antes de que
  // existiera 'github-issues' y quedara ambiguo cuál era cuál. Las filas ya
  // guardadas (SQLite + los projects.yaml de los runners) siguen abriendo;
  // el form de proyecto ya no lo ofrece. Se puede borrar cuando una
  // migración normalice `projects.source_kind`.
  factory.add('github', buildGitHubProjects, { aliasOf: 'github-projects' })
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
    // Opcional: sin ella el source vigila TODO issue abierto del repo (ver
    // GitHubIssueSourceConfig.anchorLabel). Un string vacío se trata como
    // ausente en vez de como "ninguna label matchea", que es lo que GitHub
    // entendería si lo mandáramos tal cual.
    if (anchorLabel !== undefined && typeof anchorLabel !== 'string') {
      throw new Error('github-issues source config.anchorLabel must be a string when present')
    }
    return new GitHubIssueSource({ owner, repo, anchorLabel: anchorLabel || undefined })
  })
  return factory
}
