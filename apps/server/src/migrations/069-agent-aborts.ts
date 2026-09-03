import type { Migration } from './runner.js'

// Un abort por stream-stall/overload de upstream (UpstreamAbortError, ver
// Agent.ts) no dejaba rastro: sin comentario en el issue y sin retry — ni el
// polling ni el webhook re-disparan sobre un status que no cambió (ver
// diffStatus). Esta tabla es lo que lo hace visible y reintentable: una fila
// por (task, agente) mientras el abort sigue sin resolverse, con el backoff
// del próximo retry automático.
const migration: Migration = {
  id: '069-agent-aborts',
  description: 'Create agent_aborts table — tracking + retry de upstream-aborts',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS agent_aborts (
        id            TEXT PRIMARY KEY NOT NULL,
        project_id    TEXT NOT NULL,
        task_id       TEXT NOT NULL,
        agent_id      TEXT NOT NULL,
        run_id        TEXT,
        reason        TEXT NOT NULL,
        error_msg     TEXT,
        attempts      INTEGER NOT NULL DEFAULT 1,
        max_attempts  INTEGER NOT NULL DEFAULT 3,
        status        TEXT NOT NULL DEFAULT 'pending',
        next_retry_at TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        resolved_at   TEXT
      )
    `)
    db.run('CREATE INDEX IF NOT EXISTS idx_agent_aborts_project ON agent_aborts(project_id)')
    // Una fila "abierta" (pending|exhausted) por task+agente: es la que
    // `recordAbort`/`resolveOpen` buscan en cada run.
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_agent_aborts_task_agent ON agent_aborts(task_id, agent_id)',
    )
    // Lo que consulta el barrido periódico: due = status pending y next_retry_at vencido.
    db.run('CREATE INDEX IF NOT EXISTS idx_agent_aborts_due ON agent_aborts(status, next_retry_at)')
  },
}

export default migration
