import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import { ProjectConfigSchema } from '@ia-flow/shared'
import type {
  RepoMapping,
  RepoMappingEntry,
  RepoWorkflow,
  AgentDefinition,
  StatusConfig,
  ProjectConfig,
  RepoRegistryEntry,
} from '@ia-flow/shared'

const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'
export const CONFIG_DIR = join(HOME, '.config', 'ia-flow')
const DB_PATH = join(CONFIG_DIR, 'ia-flow.sqlite')

let _db: Database | null = null

// ─── DB init ──────────────────────────────────────────────────────────────────

export function getDb(): Database {
  if (_db) return _db
  mkdirSync(CONFIG_DIR, { recursive: true })
  _db = new Database(DB_PATH)

  // Repo mappings (GitHub owner/repo/path/workflow)
  _db.run(`
    CREATE TABLE IF NOT EXISTS repos (
      name         TEXT PRIMARY KEY NOT NULL,
      path         TEXT,
      github_owner TEXT,
      github_repo  TEXT,
      workflow     TEXT
    )
  `)

  // Project-level settings (name, language, etc.) — key/value store
  _db.run(`
    CREATE TABLE IF NOT EXISTS project_settings (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `)

  // Agent definitions
  _db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id       TEXT PRIMARY KEY NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL,
      prompt   TEXT NOT NULL,
      variables TEXT
    )
  `)

  // Status configs (ordered)
  _db.run(`
    CREATE TABLE IF NOT EXISTS statuses (
      name          TEXT PRIMARY KEY NOT NULL,
      position      INTEGER NOT NULL DEFAULT 0,
      context_repos TEXT,
      agents        TEXT NOT NULL DEFAULT '[]'
    )
  `)

  // Repo registry (path+type for agent context, separate from repo mappings)
  _db.run(`
    CREATE TABLE IF NOT EXISTS repo_registry (
      name TEXT PRIMARY KEY NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL
    )
  `)

  return _db
}

// ─── Repo mappings ─────────────────────────────────────────────────────────

export interface DbRepoEntry {
  name: string
  path?: string
  githubOwner?: string
  githubRepo?: string
  workflow?: RepoWorkflow
}

function rowToRepoEntry(row: Record<string, unknown>): DbRepoEntry {
  const entry: DbRepoEntry = { name: row.name as string }
  if (row.path) entry.path = row.path as string
  if (row.github_owner) entry.githubOwner = row.github_owner as string
  if (row.github_repo) entry.githubRepo = row.github_repo as string
  if (row.workflow) entry.workflow = row.workflow as RepoWorkflow
  return entry
}

export function listDbRepos(): DbRepoEntry[] {
  const rows = getDb().query('SELECT * FROM repos ORDER BY name').all() as Record<string, unknown>[]
  return rows.map(rowToRepoEntry)
}

export function getDbRepo(name: string): DbRepoEntry | null {
  const row = getDb().query('SELECT * FROM repos WHERE name = ?').get(name) as Record<string, unknown> | null
  return row ? rowToRepoEntry(row) : null
}

export function upsertDbRepo(entry: DbRepoEntry): void {
  getDb().run(
    `INSERT INTO repos (name, path, github_owner, github_repo, workflow)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       path         = excluded.path,
       github_owner = excluded.github_owner,
       github_repo  = excluded.github_repo,
       workflow     = excluded.workflow`,
    [entry.name, entry.path ?? null, entry.githubOwner ?? null, entry.githubRepo ?? null, entry.workflow ?? null],
  )
}

export function deleteDbRepo(name: string): void {
  getDb().run('DELETE FROM repos WHERE name = ?', [name])
}

export function bulkSetRepos(mapping: RepoMapping): void {
  const db = getDb()
  db.transaction(() => {
    db.run('DELETE FROM repos')
    for (const [name, value] of Object.entries(mapping)) {
      if (typeof value === 'string') {
        upsertDbRepo({ name, githubRepo: value })
      } else if (value && typeof value === 'object') {
        const v = value as RepoMappingEntry
        upsertDbRepo({ name, path: v.path, githubOwner: v.githubOwner, githubRepo: v.githubRepo, workflow: v.workflow })
      }
    }
  })()
}

export function dbReposToMapping(): RepoMapping {
  const entries = listDbRepos()
  return Object.fromEntries(entries.map(({ name, ...rest }) => [name, rest as RepoMappingEntry]))
}

// ─── Project settings ─────────────────────────────────────────────────────

export function getProjectSettings(): Record<string, string> {
  const rows = getDb().query('SELECT key, value FROM project_settings').all() as { key: string; value: string }[]
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

function setProjectSettings(settings: Record<string, string>): void {
  const db = getDb()
  for (const [key, value] of Object.entries(settings)) {
    db.run(
      `INSERT INTO project_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    )
  }
}

// ─── Agents ───────────────────────────────────────────────────────────────

export function listDbAgents(): AgentDefinition[] {
  const rows = getDb().query('SELECT * FROM agents ORDER BY position').all() as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as string,
    provider: r.provider as string,
    prompt: r.prompt as string,
    variables: r.variables ? (JSON.parse(r.variables as string) as Record<string, string>) : undefined,
  }))
}

function upsertDbAgent(agent: AgentDefinition, position: number): void {
  getDb().run(
    `INSERT INTO agents (id, position, provider, prompt, variables)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       position  = excluded.position,
       provider  = excluded.provider,
       prompt    = excluded.prompt,
       variables = excluded.variables`,
    [agent.id, position, agent.provider, agent.prompt, agent.variables ? JSON.stringify(agent.variables) : null],
  )
}

// ─── Statuses ─────────────────────────────────────────────────────────────

function serializeContextRepos(repos: StatusConfig['context']): string | null {
  const r = repos?.repos
  if (r === undefined) return null
  if (r === 'task' || r === 'all') return r
  return JSON.stringify(r)
}

function deserializeContextRepos(raw: string | null): StatusConfig['context'] {
  if (raw === null) return undefined
  if (raw === 'task' || raw === 'all') return { repos: raw }
  try {
    return { repos: JSON.parse(raw) }
  } catch {
    return undefined
  }
}

export function listDbStatuses(): StatusConfig[] {
  const rows = getDb().query('SELECT * FROM statuses ORDER BY position').all() as Record<string, unknown>[]
  return rows.map((r) => ({
    name: r.name as string,
    context: deserializeContextRepos(r.context_repos as string | null),
    agents: JSON.parse(r.agents as string),
  }))
}

function upsertDbStatus(status: StatusConfig, position: number): void {
  getDb().run(
    `INSERT INTO statuses (name, position, context_repos, agents)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       position      = excluded.position,
       context_repos = excluded.context_repos,
       agents        = excluded.agents`,
    [status.name, position, serializeContextRepos(status.context), JSON.stringify(status.agents)],
  )
}

// ─── Repo registry ────────────────────────────────────────────────────────

export function listDbRepoRegistry(): Record<string, RepoRegistryEntry> {
  const rows = getDb().query('SELECT * FROM repo_registry').all() as Record<string, unknown>[]
  return Object.fromEntries(rows.map((r) => [r.name as string, { path: r.path as string, type: r.type as RepoRegistryEntry['type'] }]))
}

function upsertDbRepoRegistry(name: string, entry: RepoRegistryEntry): void {
  getDb().run(
    `INSERT INTO repo_registry (name, path, type) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET path = excluded.path, type = excluded.type`,
    [name, entry.path, entry.type],
  )
}

// ─── Project config (full read / write) ────────────────────────────────────

export function getProjectConfigFromDb(): ProjectConfig {
  const settings = getProjectSettings()
  return {
    project: {
      name: settings['project.name'],
      language: settings['project.language'],
    },
    agents: listDbAgents(),
    statuses: listDbStatuses(),
    repos: listDbRepoRegistry(),
  }
}

export function saveProjectConfigToDb(config: ProjectConfig): void {
  const db = getDb()
  db.transaction(() => {
    // Settings
    const s: Record<string, string> = {}
    if (config.project?.name !== undefined) s['project.name'] = config.project.name
    if (config.project?.language !== undefined) s['project.language'] = config.project.language
    if (Object.keys(s).length) setProjectSettings(s)

    // Agents (full replace)
    if (config.agents !== undefined) {
      db.run('DELETE FROM agents')
      config.agents.forEach((a, i) => upsertDbAgent(a, i))
    }

    // Statuses (full replace)
    if (config.statuses !== undefined) {
      db.run('DELETE FROM statuses')
      config.statuses.forEach((s, i) => upsertDbStatus(s, i))
    }

    // Repo registry (full replace)
    if (config.repos !== undefined) {
      db.run('DELETE FROM repo_registry')
      for (const [name, entry] of Object.entries(config.repos)) {
        upsertDbRepoRegistry(name, entry)
      }
    }
  })()
}

// ─── Migrations ───────────────────────────────────────────────────────────

const PROVIDERS_JSON = join(import.meta.dir, '..', '..', 'config', 'providers.json')

export function migrateFromProvidersJson(): void {
  if (!existsSync(PROVIDERS_JSON)) return
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(PROVIDERS_JSON, 'utf-8'))
  } catch {
    return
  }
  const repoMappings = raw?.repoMappings
  if (!repoMappings || typeof repoMappings !== 'object' || Array.isArray(repoMappings)) return
  if (Object.keys(repoMappings as object).length === 0) return

  const existing = getDb().query('SELECT COUNT(*) as count FROM repos').get() as { count: number }
  if (existing.count > 0) return

  for (const [name, value] of Object.entries(repoMappings as Record<string, unknown>)) {
    if (typeof value === 'string') {
      upsertDbRepo({ name, githubRepo: value })
    } else if (value && typeof value === 'object') {
      const v = value as RepoMappingEntry
      upsertDbRepo({ name, path: v.path, githubOwner: v.githubOwner, githubRepo: v.githubRepo, workflow: v.workflow })
    }
  }

  const { repoMappings: _removed, ...rest } = raw as { repoMappings: unknown } & Record<string, unknown>
  writeFileSync(PROVIDERS_JSON, JSON.stringify(rest, null, 2), 'utf-8')
}

const PROJECT_CONFIG_YAML = join(import.meta.dir, '..', '..', 'config', 'project-config.yaml')

export function migrateFromProjectConfigYaml(): void {
  if (!existsSync(PROJECT_CONFIG_YAML)) return

  // Only migrate if agents table is empty (first run)
  const existing = getDb().query('SELECT COUNT(*) as count FROM agents').get() as { count: number }
  if (existing.count > 0) return

  try {
    const raw = readFileSync(PROJECT_CONFIG_YAML, 'utf-8')
    const parsed = parseYaml(raw)
    const config = ProjectConfigSchema.parse(parsed)
    saveProjectConfigToDb(config)
    // Rename instead of delete — keep as reference backup
    renameSync(PROJECT_CONFIG_YAML, PROJECT_CONFIG_YAML + '.migrated')
  } catch {
    // Non-fatal — if YAML is invalid or empty, just skip
  }
}
