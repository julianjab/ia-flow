import type { Database } from 'bun:sqlite'
import type { RepoMapping, RepoMappingEntry, RepoWorkflow, SlackMemberRef } from '@ia-flow/shared'
import type { SlackReviewMessage } from '@ia-flow/shared'
import { SlackMemberRefSchema, SlackReviewMessageSchema } from '@ia-flow/shared'
import type { DbRepoEntry, IRepoRepository } from '../../../domain/ports/IRepoRepository.js'

// `slack_reviewers` es un blob JSON escrito por esta misma clase, pero también
// editable a mano en el SQLite: se valida al leer y una fila corrupta se trata
// como "sin reviewers" en vez de tumbar el listado de repos entero.
function parseReviewers(raw: unknown): SlackMemberRef[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    const parsed = SlackMemberRefSchema.array().safeParse(JSON.parse(raw))
    return parsed.success && parsed.data.length ? parsed.data : undefined
  } catch {
    return undefined
  }
}

// Misma política que `parseReviewers`: es JSON editable a mano, y una plantilla
// corrupta hace que el repo herede en vez de tumbar el listado.
function parseReviewMessage(raw: unknown): SlackReviewMessage | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    const parsed = SlackReviewMessageSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return undefined
    return parsed.data.first || parsed.data.reReview ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export class SqliteRepoRepository implements IRepoRepository {
  constructor(private db: Database) {}

  // ─── project-scoped ─────────────────────────────────────────────────────
  listByProject(projectId: string): DbRepoEntry[] {
    const rows = this.db
      .query('SELECT * FROM repos WHERE project_id = ? ORDER BY name')
      .all(projectId) as Record<string, unknown>[]
    return rows.map(this.rowToEntry)
  }

  getByProject(name: string, projectId: string): DbRepoEntry | null {
    const row = this.db
      .query('SELECT * FROM repos WHERE name = ? AND project_id = ?')
      .get(name, projectId) as Record<string, unknown> | null
    return row ? this.rowToEntry(row) : null
  }

  upsert(entry: DbRepoEntry): void {
    this.db.run(
      `INSERT INTO repos (name, path, github_owner, github_repo, workflow, description,
                          slack_review_channel, slack_reviewers, slack_review_message,
                          project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, project_id) DO UPDATE SET
         path            = excluded.path,
         github_owner    = excluded.github_owner,
         github_repo     = excluded.github_repo,
         workflow        = excluded.workflow,
         description     = excluded.description,
         slack_review_channel = excluded.slack_review_channel,
         slack_reviewers = excluded.slack_reviewers,
         slack_review_message = excluded.slack_review_message`,
      [
        entry.name,
        entry.path ?? null,
        entry.githubOwner ?? null,
        entry.githubRepo ?? null,
        entry.workflow ?? null,
        entry.description ?? null,
        entry.slackReviewChannel ?? null,
        entry.slackReviewers ? JSON.stringify(entry.slackReviewers) : null,
        entry.slackReviewMessage ? JSON.stringify(entry.slackReviewMessage) : null,
        entry.projectId,
      ],
    )
  }

  deleteByProject(name: string, projectId: string): void {
    this.db.run('DELETE FROM repos WHERE name = ? AND project_id = ?', [name, projectId])
  }

  // ─── name-only lookups (legacy path) ────────────────────────────────────
  // Names are unique per project but may repeat across projects. We return
  // the first row so existing callers (resolveGithubRepo, getRepoPaths,
  // getRepoWorkflow) keep working. Prefer `getByProject` when you know it.
  list(): DbRepoEntry[] {
    const rows = this.db.query('SELECT * FROM repos ORDER BY name').all() as Record<
      string,
      unknown
    >[]
    return rows.map(this.rowToEntry)
  }

  get(name: string): DbRepoEntry | null {
    const row = this.db.query('SELECT * FROM repos WHERE name = ? LIMIT 1').get(name) as Record<
      string,
      unknown
    > | null
    return row ? this.rowToEntry(row) : null
  }

  // ─── cross-project lookups ─────────────────────────────────────────────
  findByGithubRepo(owner: string, repo: string): DbRepoEntry[] {
    const rows = this.db
      .query('SELECT * FROM repos WHERE github_owner = ? AND github_repo = ?')
      .all(owner, repo) as Record<string, unknown>[]
    return rows.map(this.rowToEntry)
  }

  findByPath(path: string): DbRepoEntry[] {
    const rows = this.db.query('SELECT * FROM repos WHERE path = ?').all(path) as Record<
      string,
      unknown
    >[]
    return rows.map(this.rowToEntry)
  }

  // ─── legacy provider-config bridge ─────────────────────────────────────
  bulkSet(mapping: RepoMapping, projectId: string): void {
    this.db.transaction(() => {
      for (const [name, value] of Object.entries(mapping)) {
        if (typeof value === 'string') {
          this.upsert({ name, projectId, githubRepo: value })
        } else if (value && typeof value === 'object') {
          const v = value as RepoMappingEntry
          this.upsert({
            name,
            projectId,
            path: v.path,
            githubOwner: v.githubOwner,
            githubRepo: v.githubRepo,
            workflow: v.workflow,
            description: v.description,
            slackReviewChannel: v.slackReviewChannel,
            slackReviewers: v.slackReviewers,
            slackReviewMessage: v.slackReviewMessage,
          })
        }
      }
    })()
  }

  toMapping(projectId: string): RepoMapping {
    const entries = this.listByProject(projectId)
    return Object.fromEntries(
      entries.map(({ name, projectId: _pid, ...rest }) => [name, rest as RepoMappingEntry]),
    )
  }

  private rowToEntry(row: Record<string, unknown>): DbRepoEntry {
    const entry: DbRepoEntry = {
      name: row.name as string,
      projectId: row.project_id as string,
    }
    if (row.path) entry.path = row.path as string
    if (row.github_owner) entry.githubOwner = row.github_owner as string
    if (row.github_repo) entry.githubRepo = row.github_repo as string
    if (row.workflow) entry.workflow = row.workflow as RepoWorkflow
    if (row.description) entry.description = row.description as string
    if (row.slack_review_channel) entry.slackReviewChannel = row.slack_review_channel as string
    const reviewers = parseReviewers(row.slack_reviewers)
    if (reviewers) entry.slackReviewers = reviewers
    const messages = parseReviewMessage(row.slack_review_message)
    if (messages) entry.slackReviewMessage = messages
    return entry
  }
}
