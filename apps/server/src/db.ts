import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ProjectConfigSchema } from '@ia-flow/shared'
import type {
  AgentDefinition,
  ProjectConfig,
  RepoMapping,
  RepoMappingEntry,
  RepoWorkflow,
  StatusConfig,
  SystemPromptDef,
} from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import { runMigrationsSync } from './migrations/runner.js'

const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'
const DEFAULT_CONFIG_DIR = join(HOME, '.config', 'ia-flow')

// Both are configurable via env vars so tests, containers and alt installs
// don't collide with the developer's ~/.config/ia-flow SQLite file.
export const CONFIG_DIR = Bun.env.IA_FLOW_CONFIG_DIR ?? DEFAULT_CONFIG_DIR
const DB_PATH = Bun.env.IA_FLOW_DB_PATH ?? join(CONFIG_DIR, 'ia-flow.sqlite')

let _db: Database | null = null

// ─── DB init ──────────────────────────────────────────────────────────────────

export function getDb(): Database {
  if (_db) return _db
  mkdirSync(CONFIG_DIR, { recursive: true })
  _db = new Database(DB_PATH)

  // All schema DDL lives in migrations/ — see 000-bootstrap-schema.ts for the
  // baseline tables. `getDb()` intentionally does not run any CREATE/DROP so
  // migrations remain the single source of truth for schema shape.
  runMigrationsSync(_db)

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
  const row = getDb().query('SELECT * FROM repos WHERE name = ?').get(name) as Record<
    string,
    unknown
  > | null
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
    [
      entry.name,
      entry.path ?? null,
      entry.githubOwner ?? null,
      entry.githubRepo ?? null,
      entry.workflow ?? null,
    ],
  )
}

export function deleteDbRepo(name: string): void {
  getDb().run('DELETE FROM repos WHERE name = ?', [name])
}

// Upsert-only: never wipes the table. Removing a repo goes through
// `deleteDbRepo()` explicitly (see routes/tasks.ts). Historically this used
// `DELETE FROM repos` first, which caused the whole table to be cleared when
// a client saved provider config with an empty `repoMappings: {}` payload.
export function bulkSetRepos(mapping: RepoMapping): void {
  const db = getDb()
  db.transaction(() => {
    for (const [name, value] of Object.entries(mapping)) {
      if (typeof value === 'string') {
        upsertDbRepo({ name, githubRepo: value })
      } else if (value && typeof value === 'object') {
        const v = value as RepoMappingEntry
        upsertDbRepo({
          name,
          path: v.path,
          githubOwner: v.githubOwner,
          githubRepo: v.githubRepo,
          workflow: v.workflow,
        })
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
  const rows = getDb().query('SELECT key, value FROM project_settings').all() as {
    key: string
    value: string
  }[]
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

// ─── Projects (multi-tenant root) ─────────────────────────────────────────

// Fallback used by legacy callers that don't yet pass a projectId. Resolves at
// call time (not import time) so tests with custom seed data still work.
export function getDefaultProjectId(): string {
  const row = getDb()
    .query('SELECT id FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC LIMIT 1')
    .get() as { id: string } | null
  if (!row) throw new Error('No project exists — migration 005 must run before DB access')
  return row.id
}

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    githubProjectUrl: (row.github_project_url as string | null) ?? null,
    settings: row.settings ? (JSON.parse(row.settings as string) as Record<string, unknown>) : {},
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    archivedAt: (row.archived_at as string | null) ?? null,
  }
}

export function listDbProjects(includeArchived = false): Project[] {
  const sql = includeArchived
    ? 'SELECT * FROM projects ORDER BY created_at ASC'
    : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC'
  const rows = getDb().query(sql).all() as Record<string, unknown>[]
  return rows.map(rowToProject)
}

export function getDbProject(id: string): Project | null {
  const row = getDb().query('SELECT * FROM projects WHERE id = ?').get(id) as Record<
    string,
    unknown
  > | null
  return row ? rowToProject(row) : null
}

export function upsertDbProject(
  input: Omit<Project, 'createdAt' | 'updatedAt' | 'archivedAt'>,
): Project {
  const now = new Date().toISOString()
  const settings = input.settings ?? {}
  getDb().run(
    `INSERT INTO projects (id, name, github_project_url, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name               = excluded.name,
       github_project_url = excluded.github_project_url,
       settings           = excluded.settings,
       updated_at         = excluded.updated_at`,
    [input.id, input.name, input.githubProjectUrl ?? null, JSON.stringify(settings), now, now],
  )
  const created = getDbProject(input.id)
  if (!created) throw new Error(`Project ${input.id} not found after upsert`)
  return created
}

export function archiveDbProject(id: string): void {
  const now = new Date().toISOString()
  getDb().run('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?', [now, now, id])
}

// ─── System prompts library ───────────────────────────────────────────────

// projectId semantics (strict for CRUD — overlay lives in
// listSystemPromptsForRuntime below):
//   undefined → every row (admin/debug view)
//   string    → rows scoped to that project only (WHERE project_id = ?)
//   null      → global rows only (WHERE project_id IS NULL)
export function listDbSystemPrompts(projectId?: string | null): SystemPromptDef[] {
  let sql = 'SELECT * FROM system_prompts'
  const params: (string | null)[] = []
  if (projectId === null) {
    sql += ' WHERE project_id IS NULL'
  } else if (typeof projectId === 'string') {
    sql += ' WHERE project_id = ?'
    params.push(projectId)
  }
  sql += ' ORDER BY position'
  const rows = getDb()
    .query(sql)
    .all(...params) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    text: r.text as string,
    projectId: (r.project_id as string | null) ?? null,
  }))
}

// Runtime overlay: returns rows visible to a project (its own + globals),
// with project rows shadowing globals when ids collide. Use this in the daemon
// when resolving which prompt/agent to execute — not from CRUD endpoints.
export function listSystemPromptsForRuntime(projectId: string): SystemPromptDef[] {
  const rows = getDb()
    .query(
      'SELECT * FROM system_prompts WHERE project_id = ? OR project_id IS NULL ORDER BY position',
    )
    .all(projectId) as Record<string, unknown>[]
  const byId = new Map<string, SystemPromptDef>()
  for (const r of rows) {
    const sp: SystemPromptDef = {
      id: r.id as string,
      name: r.name as string,
      text: r.text as string,
      projectId: (r.project_id as string | null) ?? null,
    }
    const existing = byId.get(sp.id)
    if (!existing || (existing.projectId == null && sp.projectId != null)) byId.set(sp.id, sp)
  }
  return Array.from(byId.values())
}

export function upsertDbSystemPrompt(
  sp: SystemPromptDef,
  position: number,
  projectId?: string | null,
): void {
  const pid = projectId === undefined ? (sp.projectId ?? null) : projectId
  getDb().run(
    `INSERT INTO system_prompts (id, name, text, position, project_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name       = excluded.name,
       text       = excluded.text,
       position   = excluded.position,
       project_id = excluded.project_id`,
    [sp.id, sp.name, sp.text, position, pid],
  )
}

export function deleteDbSystemPrompt(id: string): void {
  getDb().run('DELETE FROM system_prompts WHERE id = ?', [id])
}

// ─── Agents ───────────────────────────────────────────────────────────────

// projectId semantics (strict for CRUD — overlay is `listAgentsForRuntime`):
//   undefined → every row
//   string    → rows scoped to that project only
//   null      → global rows only
export function listDbAgents(projectId?: string | null): AgentDefinition[] {
  let sql = 'SELECT * FROM agents'
  const params: (string | null)[] = []
  if (projectId === null) {
    sql += ' WHERE project_id IS NULL'
  } else if (typeof projectId === 'string') {
    sql += ' WHERE project_id = ?'
    params.push(projectId)
  }
  sql += ' ORDER BY position'
  const rows = getDb()
    .query(sql)
    .all(...params) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as string,
    provider: r.provider as string,
    prompt: r.prompt as string,
    variables: r.variables
      ? (JSON.parse(r.variables as string) as Record<string, string>)
      : undefined,
    tools: r.tools ? (JSON.parse(r.tools as string) as string[]) : undefined,
    systemPrompts: r.system_prompts
      ? (JSON.parse(r.system_prompts as string) as string[])
      : undefined,
    save_output: r.save_output != null ? (r.save_output as number) !== 0 : undefined,
    projectId: (r.project_id as string | null) ?? null,
  }))
}

export function listAgentsForRuntime(projectId: string): AgentDefinition[] {
  const rows = getDb()
    .query('SELECT * FROM agents WHERE project_id = ? OR project_id IS NULL ORDER BY position')
    .all(projectId) as Record<string, unknown>[]
  const byId = new Map<string, AgentDefinition>()
  for (const r of rows) {
    const a: AgentDefinition = {
      id: r.id as string,
      provider: r.provider as string,
      prompt: r.prompt as string,
      variables: r.variables
        ? (JSON.parse(r.variables as string) as Record<string, string>)
        : undefined,
      tools: r.tools ? (JSON.parse(r.tools as string) as string[]) : undefined,
      systemPrompts: r.system_prompts
        ? (JSON.parse(r.system_prompts as string) as string[])
        : undefined,
      save_output: r.save_output != null ? (r.save_output as number) !== 0 : undefined,
      projectId: (r.project_id as string | null) ?? null,
    }
    const existing = byId.get(a.id)
    if (!existing || (existing.projectId == null && a.projectId != null)) byId.set(a.id, a)
  }
  return Array.from(byId.values())
}

function upsertDbAgent(agent: AgentDefinition, position: number, projectId?: string | null): void {
  const pid = projectId === undefined ? (agent.projectId ?? null) : projectId
  getDb().run(
    `INSERT INTO agents (id, position, provider, prompt, variables, tools, system_prompts, save_output, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       position       = excluded.position,
       provider       = excluded.provider,
       prompt         = excluded.prompt,
       variables      = excluded.variables,
       tools          = excluded.tools,
       system_prompts = excluded.system_prompts,
       save_output    = excluded.save_output,
       project_id     = excluded.project_id`,
    [
      agent.id,
      position,
      agent.provider,
      agent.prompt,
      agent.variables ? JSON.stringify(agent.variables) : null,
      agent.tools?.length ? JSON.stringify(agent.tools) : null,
      agent.systemPrompts?.length ? JSON.stringify(agent.systemPrompts) : null,
      agent.save_output === false ? 0 : agent.save_output === true ? 1 : null,
      pid,
    ],
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

// Statuses are always project-scoped. Passing no projectId returns every row
// (admin / debug view); normal callers must scope by project.
export function listDbStatuses(projectId?: string): StatusConfig[] {
  const sql =
    projectId === undefined
      ? 'SELECT * FROM statuses ORDER BY project_id, position'
      : 'SELECT * FROM statuses WHERE project_id = ? ORDER BY position'
  const params = projectId === undefined ? [] : [projectId]
  const rows = getDb()
    .query(sql)
    .all(...params) as Record<string, unknown>[]
  return rows.map((r) => ({
    name: r.name as string,
    projectId: r.project_id as string,
    context: deserializeContextRepos(r.context_repos as string | null),
    agents: JSON.parse(r.agents as string),
  }))
}

function upsertDbStatus(status: StatusConfig, position: number, projectId: string): void {
  getDb().run(
    `INSERT INTO statuses (project_id, name, position, context_repos, agents)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, name) DO UPDATE SET
       position      = excluded.position,
       context_repos = excluded.context_repos,
       agents        = excluded.agents`,
    [
      projectId,
      status.name,
      position,
      serializeContextRepos(status.context),
      JSON.stringify(status.agents),
    ],
  )
}

// ─── Scan roots ───────────────────────────────────────────────────────────────

export function getScanRoots(): string[] {
  const row = getDb()
    .query('SELECT value FROM project_settings WHERE key = ?')
    .get('scan_roots') as { value: string } | null
  if (!row) return []
  try {
    return JSON.parse(row.value) as string[]
  } catch {
    return []
  }
}

export function setScanRoots(roots: string[]): void {
  getDb().run(
    `INSERT INTO project_settings (key, value) VALUES ('scan_roots', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(roots)],
  )
}

// ─── Project config (full read / write) ────────────────────────────────────

// scope semantics:
//   undefined → default project (back-compat single-tenant callers)
//   string    → that specific project's own rows (no overlay — strict)
//   null      → global rows only (project_id IS NULL); statuses are empty
//               since statuses always belong to a project
export function getProjectConfigFromDb(scope?: string | null): ProjectConfig {
  const resolved = scope === undefined ? getDefaultProjectId() : scope
  const settings = getProjectSettings()
  const systemPrompts = listDbSystemPrompts(resolved)
  const scanRoots = getScanRoots()
  return {
    project: {
      name: settings['project.name'],
      language: settings['project.language'],
    },
    systemPrompts: systemPrompts.length ? systemPrompts : undefined,
    agents: listDbAgents(resolved),
    statuses: resolved === null ? [] : listDbStatuses(resolved),
    scanRoots: scanRoots.length ? scanRoots : undefined,
  }
}

// Writes only rows scoped to the given target — never crosses scope boundaries:
//   scope=projectId (string) → replaces agents/prompts/statuses WHERE project_id = pid
//   scope=null               → replaces globals WHERE project_id IS NULL (statuses skipped)
//   scope=undefined          → default project
export function saveProjectConfigToDb(config: ProjectConfig, scope?: string | null): void {
  const target = scope === undefined ? getDefaultProjectId() : scope
  const db = getDb()
  db.transaction(() => {
    // Settings
    const s: Record<string, string> = {}
    if (config.project?.name !== undefined) s['project.name'] = config.project.name
    if (config.project?.language !== undefined) s['project.language'] = config.project.language
    if (Object.keys(s).length) setProjectSettings(s)

    if (config.systemPrompts !== undefined) {
      if (target === null) {
        db.run('DELETE FROM system_prompts WHERE project_id IS NULL')
      } else {
        db.run('DELETE FROM system_prompts WHERE project_id = ?', [target])
      }
      config.systemPrompts.forEach((sp, i) => upsertDbSystemPrompt(sp, i, target))
    }

    if (config.agents !== undefined) {
      if (target === null) {
        db.run('DELETE FROM agents WHERE project_id IS NULL')
      } else {
        db.run('DELETE FROM agents WHERE project_id = ?', [target])
      }
      config.agents.forEach((a, i) => upsertDbAgent(a, i, target))
    }

    // Statuses always belong to a project — skip for global scope.
    if (config.statuses !== undefined && target !== null) {
      db.run('DELETE FROM statuses WHERE project_id = ?', [target])
      config.statuses.forEach((st, i) => upsertDbStatus(st, i, target))
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
      upsertDbRepo({
        name,
        path: v.path,
        githubOwner: v.githubOwner,
        githubRepo: v.githubRepo,
        workflow: v.workflow,
      })
    }
  }

  const { repoMappings: _removed, ...rest } = raw as { repoMappings: unknown } & Record<
    string,
    unknown
  >
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

// Seed the system_prompts library from the hardcoded DEFAULT_ANTHROPIC_SETTINGS blocks.
// Only runs once (skips if table already has rows).
export function migrateHardcodedSystemPrompts(
  blocks: Array<{ text: string }>,
  names: string[],
): void {
  const count = (getDb().query('SELECT COUNT(*) as c FROM system_prompts').get() as { c: number }).c
  if (count > 0) return

  const toId = (name: string) =>
    name
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .split(' ')
      .filter(Boolean)
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join('')

  blocks.forEach((block, i) => {
    const name = names[i] ?? `System Prompt ${i + 1}`
    upsertDbSystemPrompt({ id: toId(name), name, text: block.text }, i)
  })
}

// Insert a system prompt only if its id doesn't exist yet.
// Safe to call on every startup — skips silently if already present.
export function seedSystemPromptIfMissing(sp: SystemPromptDef): void {
  const existing = getDb().query('SELECT id FROM system_prompts WHERE id = ?').get(sp.id)
  if (existing) return
  const maxPos =
    (getDb().query('SELECT MAX(position) as m FROM system_prompts').get() as { m: number | null })
      .m ?? -1
  upsertDbSystemPrompt(sp, maxPos + 1)
}

// ─── Env vars (stored with "env." prefix in project_settings) ──────────────

export function getDbEnvVar(key: string): string | null {
  const row = getDb()
    .query('SELECT value FROM project_settings WHERE key = ?')
    .get(`env.${key}`) as { value: string } | null
  return row?.value ?? null
}

export function setDbEnvVar(key: string, value: string): void {
  getDb().run(
    `INSERT INTO project_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [`env.${key}`, value],
  )
}

export function deleteDbEnvVar(key: string): void {
  getDb().run('DELETE FROM project_settings WHERE key = ?', [`env.${key}`])
}

// ─── Provider config (non-repo settings stored as a JSON blob) ────────────────

export function getProviderConfigFromDb(): Record<string, unknown> | null {
  const row = getDb()
    .query('SELECT value FROM project_settings WHERE key = ?')
    .get('provider_config') as { value: string } | null
  if (!row) return null
  try {
    return JSON.parse(row.value) as Record<string, unknown>
  } catch {
    return null
  }
}

export function setProviderConfigToDb(config: Record<string, unknown>): void {
  getDb().run(
    `INSERT INTO project_settings (key, value) VALUES ('provider_config', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(config)],
  )
}

export function deleteProviderConfigFromDb(): void {
  getDb().run("DELETE FROM project_settings WHERE key = 'provider_config'")
}

// One-time migration: reads providers.json (after repoMappings have already been
// migrated to the repos table), stores the rest as a DB blob, then deletes the file.
export function migrateProvidersJsonToDb(): void {
  const existing = getDb()
    .query('SELECT value FROM project_settings WHERE key = ?')
    .get('provider_config') as { value: string } | null
  if (existing) return
  if (!existsSync(PROVIDERS_JSON)) return

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(PROVIDERS_JSON, 'utf-8'))
  } catch {
    return
  }

  const { repoMappings: _ignored, ...rest } = raw as { repoMappings?: unknown } & Record<
    string,
    unknown
  >
  setProviderConfigToDb(rest)

  try {
    unlinkSync(PROVIDERS_JSON)
  } catch {
    /* non-fatal */
  }
}

// Called at startup to apply DB-stored env vars into the current process.
// DB values take precedence over process env vars (process env is the fallback).
export function loadEnvVarsFromDb(): void {
  const rows = getDb()
    .query("SELECT key, value FROM project_settings WHERE key LIKE 'env.%'")
    .all() as { key: string; value: string }[]
  for (const { key, value } of rows) {
    const envKey = key.slice(4) // strip "env." prefix
    ;(Bun.env as Record<string, string>)[envKey] = value
  }
}
