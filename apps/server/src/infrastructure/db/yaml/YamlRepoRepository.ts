import { readFileSync } from 'fs'
import type { RepoMapping, RepoMappingEntry } from '@ia-flow/shared'
import { RepoDefSchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import type { DbRepoEntry, IRepoRepository } from '../../../domain/ports/IRepoRepository.js'

// Read-only IRepoRepository backed by a static YAML file instead of the
// `repos` SQLite table. Same rationale as YamlAgentRepository: a fixed
// engine deployment ships its repo roster as deploy config, not something
// edited at runtime through the CRUD UI. Mutating methods throw instead of
// silently no-op-ing so a stray call fails loud rather than pretending to
// persist.
//
// `RepoDefSchema` (from @ia-flow/shared) already matches `DbRepoEntry`
// field-for-field (`name`, `projectId`, `path?`, `githubOwner?`,
// `githubRepo?`, `workflow?`, `description?`), so it's reused as-is instead
// of introducing a duplicate schema.
const YAML_REPO_SCHEMA = RepoDefSchema.array()

function readRepos(filePath: string): DbRepoEntry[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(`YamlRepoRepository: no se pudo leer '${filePath}': ${(err as Error).message}`)
  }

  const parsed = parseYaml(raw)
  const result = YAML_REPO_SCHEMA.safeParse(parsed ?? [])
  if (!result.success) {
    throw new Error(
      `YamlRepoRepository: '${filePath}' no cumple RepoDefSchema[]: ${result.error.message}`,
    )
  }
  return result.data
}

function readOnly(op: string): never {
  throw new Error(
    `YamlRepoRepository es de solo lectura (${op} no soportado) — editá el archivo YAML y reiniciá el proceso.`,
  )
}

export class YamlRepoRepository implements IRepoRepository {
  // Loaded once at construction — see YamlAgentRepository for rationale.
  private readonly repos: DbRepoEntry[]

  /**
   * Un path o los datos ya parseados. Lo segundo es lo que usa el flavor
   * `runner`, donde los repos son una sección del `runner.yaml` único en
   * vez de un archivo propio — mismo schema, mismo repo, una sola lectura de
   * disco para todas las secciones.
   */
  constructor(source: string | DbRepoEntry[]) {
    this.repos = typeof source === 'string' ? readRepos(source) : [...source]
  }

  // ─── project-scoped ─────────────────────────────────────────────────────
  listByProject(projectId: string): DbRepoEntry[] {
    return this.repos.filter((r) => r.projectId === projectId)
  }

  getByProject(name: string, projectId: string): DbRepoEntry | null {
    return this.repos.find((r) => r.name === name && r.projectId === projectId) ?? null
  }

  // `upsert` in this port normally caches the clone path the first time
  // `WorkspaceManager` clones a repo that has no `path` yet (see
  // packages/agent-engine/src/AgentOrchestrator.ts ~line 126:
  // `this.repoRepo.upsert({ ...primaryTaskRepo, path: primaryPath })`, only
  // called when `!primaryPath`). For a static YAML deploy the operator must
  // declare `path` up front in the input YAML; if they didn't, throwing here
  // instead of faking persistence is the correct behavior — it fails loud
  // instead of silently re-cloning on every dispatch without ever
  // remembering the path.
  upsert(_entry: DbRepoEntry): void {
    readOnly('upsert')
  }

  deleteByProject(_name: string, _projectId: string): void {
    readOnly('deleteByProject')
  }

  // ─── name-only lookups (legacy path) ────────────────────────────────────
  list(): DbRepoEntry[] {
    return [...this.repos]
  }

  get(name: string): DbRepoEntry | null {
    return this.repos.find((r) => r.name === name) ?? null
  }

  // ─── cross-project lookups ─────────────────────────────────────────────
  findByGithubRepo(owner: string, repo: string): DbRepoEntry[] {
    return this.repos.filter((r) => r.githubOwner === owner && r.githubRepo === repo)
  }

  findByPath(path: string): DbRepoEntry[] {
    return this.repos.filter((r) => r.path === path)
  }

  // ─── legacy provider-config bridge ─────────────────────────────────────
  bulkSet(_mapping: RepoMapping, _projectId: string): void {
    readOnly('bulkSet')
  }

  toMapping(projectId: string): RepoMapping {
    const entries = this.listByProject(projectId)
    return Object.fromEntries(
      entries.map(({ name, projectId: _pid, ...rest }) => [name, rest as RepoMappingEntry]),
    )
  }
}
