import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { AgentDefinition, Project, ProjectConfig, StatusConfig } from '@ia-flow/shared'
import type { ISystemPromptRepository } from './domain/ports/ISystemPromptRepository.js'
import { SqliteSystemPromptRepository } from './infrastructure/db/SqliteSystemPromptRepository.js'
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

let _systemPromptRepo: ISystemPromptRepository | null = null

// Lazy accessor so db.ts can delegate CRUD without pulling in the DI container.
function getSystemPromptRepo(): ISystemPromptRepository {
  if (!_systemPromptRepo) _systemPromptRepo = new SqliteSystemPromptRepository(getDb())
  return _systemPromptRepo
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
  const kind = (row.source_kind as string | null) ?? null
  const rawConfig = (row.source_config as string | null) ?? null
  const source = kind
    ? {
        kind,
        config: rawConfig ? (JSON.parse(rawConfig) as Record<string, unknown>) : {},
      }
    : undefined
  return {
    id: row.id as string,
    name: row.name as string,
    source,
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
  const sourceKind = input.source?.kind ?? null
  const sourceConfig = input.source ? JSON.stringify(input.source.config ?? {}) : null
  getDb().run(
    `INSERT INTO projects (id, name, source_kind, source_config, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name          = excluded.name,
       source_kind   = excluded.source_kind,
       source_config = excluded.source_config,
       settings      = excluded.settings,
       updated_at    = excluded.updated_at`,
    [input.id, input.name, sourceKind, sourceConfig, JSON.stringify(settings), now, now],
  )
  const created = getDbProject(input.id)
  if (!created) throw new Error(`Project ${input.id} not found after upsert`)
  return created
}

export function archiveDbProject(id: string): void {
  const now = new Date().toISOString()
  getDb().run('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?', [now, now, id])
}

// Hard delete of a project and every row it owns. Foreign-key CASCADE isn't
// enforced (PRAGMA foreign_keys is off) so we delete children explicitly:
// - statuses:      project-scoped only (project_id NOT NULL by schema)
// - agents:        only rows scoped to this project; globals (project_id IS NULL) stay
// - system_prompts: same rule as agents
// Wrapped in a single transaction so partial deletes never leak.
export function deleteDbProjectCascade(id: string): void {
  const db = getDb()
  db.transaction(() => {
    db.run('DELETE FROM statuses WHERE project_id = ?', [id])
    db.run('DELETE FROM agents WHERE project_id = ?', [id])
    db.run('DELETE FROM system_prompts WHERE project_id = ?', [id])
    db.run('DELETE FROM projects WHERE id = ?', [id])
  })()
}

// ─── System prompts library ───────────────────────────────────────────────
// CRUD moved to SqliteSystemPromptRepository (domain/ports/ISystemPromptRepository).
// This section is intentionally empty — see infrastructure/db/SqliteSystemPromptRepository.ts.

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
    providerConfig: r.provider_config
      ? (JSON.parse(r.provider_config as string) as Record<string, unknown>)
      : undefined,
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
      providerConfig: r.provider_config
        ? (JSON.parse(r.provider_config as string) as Record<string, unknown>)
        : undefined,
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
    `INSERT INTO agents (id, position, provider, prompt, variables, tools, system_prompts, save_output, provider_config, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       position        = excluded.position,
       provider        = excluded.provider,
       prompt          = excluded.prompt,
       variables       = excluded.variables,
       tools           = excluded.tools,
       system_prompts  = excluded.system_prompts,
       save_output     = excluded.save_output,
       provider_config = excluded.provider_config,
       project_id      = excluded.project_id`,
    [
      agent.id,
      position,
      agent.provider,
      agent.prompt,
      agent.variables ? JSON.stringify(agent.variables) : null,
      agent.tools?.length ? JSON.stringify(agent.tools) : null,
      agent.systemPrompts?.length ? JSON.stringify(agent.systemPrompts) : null,
      agent.save_output === false ? 0 : agent.save_output === true ? 1 : null,
      agent.providerConfig && Object.keys(agent.providerConfig).length > 0
        ? JSON.stringify(agent.providerConfig)
        : null,
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
  const systemPrompts = getSystemPromptRepo().listByProject(resolved)
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
      const repo = getSystemPromptRepo()
      repo.deleteByProject(target)
      config.systemPrompts.forEach((sp, i) => repo.upsert(sp, i, target))
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
