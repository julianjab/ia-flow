import type { SqliteDatabase } from './SqliteDatabase.js'

/**
 * El esquema, por versión. Una migración nueva se AGREGA al final — nunca se edita una que ya
 * corrió en alguna base.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE executions (
    id              TEXT PRIMARY KEY,
    key             TEXT NOT NULL,
    pipeline_id     TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('running', 'paused', 'done', 'failed', 'superseded')),
    started_at      TEXT NOT NULL,
    waited_ms       INTEGER NOT NULL DEFAULT 0,
    closed_at       TEXT,
    close_reason    TEXT,
    pause_json      TEXT,
    checkpoint_json TEXT
  );
  -- Una task tiene a lo sumo una ejecución viva.
  CREATE UNIQUE INDEX executions_live_key ON executions (key) WHERE status IN ('running', 'paused');

  CREATE TABLE execution_inbox (
    execution_id TEXT NOT NULL REFERENCES executions (id),
    seq          INTEGER NOT NULL,
    event_json   TEXT NOT NULL,
    read         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (execution_id, seq)
  );

  CREATE TABLE counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  INSERT INTO counters (name, value) VALUES ('execution', 0);
  `,
  // 2 — la actividad: cada evento y qué se decidió con él (`SqliteDispatchJournal`), y la traza de
  // cada ejecución (`SqliteTraceJournal`). Lo lee `SqliteActivityReader`.
  `
  CREATE TABLE event_log (
    id             TEXT PRIMARY KEY,
    parent_id      TEXT,
    delivery_id    TEXT,
    type           TEXT NOT NULL,
    occurred_at    TEXT NOT NULL,
    depth          INTEGER NOT NULL,
    project_id     TEXT,
    task_ref       TEXT,
    summary_json   TEXT NOT NULL,
    scope_json     TEXT,
    payload_json   TEXT,
    outcome        TEXT NOT NULL,
    error          TEXT,
    decisions_json TEXT NOT NULL,
    execution_id   TEXT,
    trace_id       TEXT,
    recorded_at    TEXT NOT NULL
  );
  CREATE INDEX event_log_task ON event_log (task_ref, occurred_at);
  CREATE INDEX event_log_delivery ON event_log (delivery_id);
  CREATE INDEX event_log_occurred ON event_log (occurred_at);

  CREATE TABLE execution_trace (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id    TEXT NOT NULL,
    kind            TEXT NOT NULL,
    phase           TEXT,
    name            TEXT NOT NULL,
    scope           TEXT,
    level           TEXT,
    status          TEXT,
    status_message  TEXT,
    start_time      TEXT NOT NULL,
    end_time        TEXT,
    duration_ms     REAL,
    trace_id        TEXT NOT NULL,
    span_id         TEXT NOT NULL,
    parent_span_id  TEXT,
    origin          TEXT NOT NULL,
    attributes_json TEXT NOT NULL
  );
  CREATE INDEX execution_trace_execution ON execution_trace (execution_id, seq);
  `,
]

/** Lleva la base a la última versión del esquema (`PRAGMA user_version`). */
export function migrate(db: SqliteDatabase): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as {
    user_version: number
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version] as string)
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
