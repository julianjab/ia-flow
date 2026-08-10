import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { AgentDefinition, ProjectConfig, StatusConfig } from '@ia-flow/shared'
import type { IAgentRepository } from './domain/ports/IAgentRepository.js'
import type { ISystemPromptRepository } from './domain/ports/ISystemPromptRepository.js'
import { SqliteAgentRepository } from './infrastructure/db/SqliteAgentRepository.js'
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
let _agentRepo: IAgentRepository | null = null

// Lazy accessors so db.ts can delegate CRUD without pulling in the DI container.
function getSystemPromptRepo(): ISystemPromptRepository {
  if (!_systemPromptRepo) _systemPromptRepo = new SqliteSystemPromptRepository(getDb())
  return _systemPromptRepo
}
function getAgentRepo(): IAgentRepository {
  if (!_agentRepo) _agentRepo = new SqliteAgentRepository(getDb())
  return _agentRepo
}

// ─── Projects (multi-tenant root) ─────────────────────────────────────────
// CRUD moved to SqliteProjectRepository. `getDefaultProjectId` stays local —
// still used by the aggregate helpers `getProjectConfigFromDb` /
// `saveProjectConfigToDb` below (folded away in step 8).
function getDefaultProjectId(): string {
  const row = getDb()
    .query('SELECT id FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC LIMIT 1')
    .get() as { id: string } | null
  if (!row) throw new Error('No project exists — migration 005 must run before DB access')
  return row.id
}

// ─── System prompts library ───────────────────────────────────────────────
// CRUD moved to SqliteSystemPromptRepository (domain/ports/ISystemPromptRepository).
// This section is intentionally empty — see infrastructure/db/SqliteSystemPromptRepository.ts.

// ─── Agents ───────────────────────────────────────────────────────────────

// CRUD moved to SqliteAgentRepository. The aggregate saveProjectConfigToDb
// below still writes agents inline — folded away in step 8.
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

// Kept local — used only by saveProjectConfigToDb below. Public reads go
// through SqliteStatusRepository.
function listDbStatuses(projectId?: string): StatusConfig[] {
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

// ─── Project config (full read / write) ────────────────────────────────────

// scope semantics:
//   undefined → default project (back-compat single-tenant callers)
//   string    → that specific project's own rows (no overlay — strict)
//   null      → global rows only (project_id IS NULL); statuses are empty
//               since statuses always belong to a project
export function getProjectConfigFromDb(scope?: string | null): ProjectConfig {
  const resolved = scope === undefined ? getDefaultProjectId() : scope
  const db = getDb()
  const projectRow =
    resolved === null
      ? null
      : (db.query('SELECT name, language FROM projects WHERE id = ?').get(resolved) as {
          name: string
          language: string | null
        } | null)
  const scanRootsRow = db
    .query("SELECT value FROM global_settings WHERE key = 'scan_roots'")
    .get() as { value: string } | null
  let scanRoots: string[] = []
  if (scanRootsRow?.value) {
    try {
      scanRoots = JSON.parse(scanRootsRow.value) as string[]
    } catch {
      scanRoots = []
    }
  }
  const systemPrompts = getSystemPromptRepo().listByProject(resolved)
  return {
    project: {
      name: projectRow?.name,
      language: projectRow?.language ?? undefined,
    },
    systemPrompts: systemPrompts.length ? systemPrompts : undefined,
    agents: getAgentRepo().listByProject(resolved),
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
    // Project row (name / language). Only when a real project is targeted.
    if (
      target !== null &&
      (config.project?.name !== undefined || config.project?.language !== undefined)
    ) {
      const now = new Date().toISOString()
      const sets: string[] = ['updated_at = ?']
      const params: (string | null)[] = [now]
      if (config.project?.name !== undefined) {
        sets.push('name = ?')
        params.push(config.project.name)
      }
      if (config.project?.language !== undefined) {
        sets.push('language = ?')
        params.push(config.project.language)
      }
      params.push(target)
      db.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, params)
    }

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
