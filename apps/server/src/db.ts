import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { RepoMapping, RepoMappingEntry, RepoWorkflow } from '@ia-flow/shared'

const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'
export const CONFIG_DIR = join(HOME, '.config', 'ia-flow')
const DB_PATH = join(CONFIG_DIR, 'ia-flow.sqlite')

let _db: Database | null = null

export interface DbRepoEntry {
  name: string
  path?: string
  githubOwner?: string
  githubRepo?: string
  workflow?: RepoWorkflow
}

export function getDb(): Database {
  if (_db) return _db
  mkdirSync(CONFIG_DIR, { recursive: true })
  _db = new Database(DB_PATH)
  _db.run(`
    CREATE TABLE IF NOT EXISTS repos (
      name        TEXT PRIMARY KEY NOT NULL,
      path        TEXT,
      github_owner TEXT,
      github_repo  TEXT,
      workflow     TEXT
    )
  `)
  return _db
}

function rowToEntry(row: Record<string, unknown>): DbRepoEntry {
  const entry: DbRepoEntry = { name: row.name as string }
  if (row.path) entry.path = row.path as string
  if (row.github_owner) entry.githubOwner = row.github_owner as string
  if (row.github_repo) entry.githubRepo = row.github_repo as string
  if (row.workflow) entry.workflow = row.workflow as RepoWorkflow
  return entry
}

export function listDbRepos(): DbRepoEntry[] {
  const rows = getDb().query('SELECT * FROM repos ORDER BY name').all() as Record<string, unknown>[]
  return rows.map(rowToEntry)
}

export function getDbRepo(name: string): DbRepoEntry | null {
  const row = getDb().query('SELECT * FROM repos WHERE name = ?').get(name) as Record<string, unknown> | null
  return row ? rowToEntry(row) : null
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

// Replaces all repo entries with the provided mapping (used by bulk-save from settings).
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

// Converts DB rows back to the RepoMapping record shape expected by the shared type.
export function dbReposToMapping(): RepoMapping {
  const entries = listDbRepos()
  return Object.fromEntries(
    entries.map(({ name, ...rest }) => [name, rest as RepoMappingEntry]),
  )
}

// One-time migration: reads repoMappings from providers.json (if present) and imports to DB.
// Strips repoMappings from the JSON file afterwards to avoid duplication.
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
