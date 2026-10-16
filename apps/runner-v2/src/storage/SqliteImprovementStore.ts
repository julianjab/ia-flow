/**
 * `ImprovementStore` sobre la misma base que la actividad del runner (`activityStore.ts`): una
 * tabla, una fila por propuesta. Los labels van como JSON.
 */
import type { Database } from 'bun:sqlite'
import type { ImprovementProposal, ImprovementStatus, ImprovementTarget } from '@ia-flow/shared'
import type {
  ImprovementDecision,
  ImprovementRevision,
  ImprovementStore,
  NewImprovement,
} from '../assistant/ImprovementStore.js'

const COLUMNS = `
    id           TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    task_ref     TEXT,
    pr_url       TEXT,
    agent        TEXT NOT NULL,
    execution_id TEXT,
    target       TEXT NOT NULL,
    repo         TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    labels_json  TEXT NOT NULL,
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL,
    issue_url    TEXT,
    decided_by   TEXT,
    decided_at   TEXT`

const INDEX = `
  CREATE INDEX IF NOT EXISTS improvement_proposal_status
    ON improvement_proposal (status, created_at);`

const SCHEMA = `CREATE TABLE IF NOT EXISTS improvement_proposal (${COLUMNS});${INDEX}`

/**
 * Una base de cuando toda mejora salía de una tarea tiene `task_ref NOT NULL`, y SQLite no sabe
 * sacarle un `NOT NULL` a una columna: se rehace la tabla con las mismas filas, todo en una
 * transacción (si algo falla, queda la de antes, entera).
 */
function allowTaskless(database: Database): void {
  const taskRef = database
    .query<{ name: string; notnull: number }, []>('PRAGMA table_info(improvement_proposal)')
    .all()
    .find((column) => column.name === 'task_ref')
  if (!taskRef?.notnull) return
  const names = COLUMNS.split(',')
    .map((column) => column.trim().split(/\s+/)[0])
    .join(', ')
  database.transaction(() => {
    database.exec(`CREATE TABLE improvement_proposal_next (${COLUMNS})`)
    database.exec(
      `INSERT INTO improvement_proposal_next (${names})
       SELECT ${names} FROM improvement_proposal ORDER BY rowid`,
    )
    database.exec('DROP TABLE improvement_proposal')
    database.exec('ALTER TABLE improvement_proposal_next RENAME TO improvement_proposal')
    database.exec(INDEX)
  })()
}

interface Row {
  id: string
  created_at: string
  task_ref: string | null
  pr_url: string | null
  agent: string
  execution_id: string | null
  target: ImprovementTarget
  repo: string
  title: string
  body: string
  labels_json: string
  reason: string
  status: ImprovementStatus
  issue_url: string | null
  decided_by: string | null
  decided_at: string | null
}

const OPTIONAL = [
  'task_ref',
  'pr_url',
  'execution_id',
  'issue_url',
  'decided_by',
  'decided_at',
] as const

function proposal(row: Row): ImprovementProposal {
  const labels = JSON.parse(row.labels_json) as string[]
  const optional = Object.fromEntries(
    OPTIONAL.filter((key) => row[key] !== null).map((key) => [key, row[key]]),
  )
  return {
    id: row.id,
    created_at: row.created_at,
    agent: row.agent,
    target: row.target,
    repo: row.repo,
    title: row.title,
    body: row.body,
    ...(labels.length ? { labels } : {}),
    reason: row.reason,
    status: row.status,
    ...optional,
  }
}

const DEFAULT_LIMIT = 100

export class SqliteImprovementStore implements ImprovementStore {
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    database.exec(SCHEMA)
    allowTaskless(database)
  }

  add(input: NewImprovement): ImprovementProposal {
    const id = globalThis.crypto.randomUUID()
    this.database
      .query(
        `INSERT INTO improvement_proposal
           (id, created_at, task_ref, pr_url, agent, execution_id, target, repo, title, body,
            labels_json, reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(
        id,
        this.now().toISOString(),
        input.task_ref ?? null,
        input.pr_url ?? null,
        input.agent,
        input.execution_id ?? null,
        input.target,
        input.repo,
        input.title,
        input.body,
        JSON.stringify(input.labels ?? []),
        input.reason,
      )
    this.changed()
    return this.get(id) as ImprovementProposal
  }

  get(id: string): ImprovementProposal | undefined {
    const row = this.database
      .query<Row, [string]>('SELECT * FROM improvement_proposal WHERE id = ?')
      .get(id)
    return row ? proposal(row) : undefined
  }

  list(status?: ImprovementStatus, limit = DEFAULT_LIMIT): ImprovementProposal[] {
    const rows = status
      ? this.database
          .query<Row, [string, number]>(
            'SELECT * FROM improvement_proposal WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
          )
          .all(status, limit)
      : this.database
          .query<Row, [number]>(
            'SELECT * FROM improvement_proposal ORDER BY created_at DESC, rowid DESC LIMIT ?',
          )
          .all(limit)
    return rows.map(proposal)
  }

  findOpen(repo: string, title: string): ImprovementProposal | undefined {
    const row = this.database
      .query<Row, [string, string]>(
        `SELECT * FROM improvement_proposal
         WHERE status = 'open' AND lower(repo) = lower(?) AND lower(trim(title)) = lower(trim(?))
         LIMIT 1`,
      )
      .get(repo, title)
    return row ? proposal(row) : undefined
  }

  revise(id: string, changes: ImprovementRevision): ImprovementProposal | undefined {
    const result = this.database
      .query(
        `UPDATE improvement_proposal
         SET title = coalesce(?, title), body = coalesce(?, body),
             labels_json = coalesce(?, labels_json), reason = coalesce(?, reason)
         WHERE id = ? AND status = 'open'`,
      )
      .run(
        changes.title ?? null,
        changes.body ?? null,
        changes.labels ? JSON.stringify(changes.labels) : null,
        changes.reason ?? null,
        id,
      )
    if (result.changes === 0) return undefined
    this.changed()
    return this.get(id)
  }

  decide(id: string, decision: ImprovementDecision): ImprovementProposal | undefined {
    const result = this.database
      .query(
        `UPDATE improvement_proposal
         SET status = ?, decided_by = ?, decided_at = ?, issue_url = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(
        decision.status,
        decision.by,
        this.now().toISOString(),
        decision.status === 'opened' ? decision.issue_url : null,
        id,
      )
    if (result.changes === 0) return undefined
    this.changed()
    return this.get(id)
  }

  prune(cutoff: string): void {
    this.database
      .query("DELETE FROM improvement_proposal WHERE status != 'open' AND decided_at < ?")
      .run(cutoff)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // Un listener roto (un cliente SSE que se fue) no corta la escritura.
      }
    }
  }
}
