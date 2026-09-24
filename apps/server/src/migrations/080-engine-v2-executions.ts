import type { Migration } from './runner.js'

// Backing durable de `ExecutionSource` (packages/engine-v2) — sólo lo que
// una Execution `waiting` necesita para sobrevivir un reinicio (ver
// Execution.wait/fromLog). NO es un historial de runs terminados (eso sigue
// siendo el ExecutionLog en memoria de engine-v2, todavía sin persistir) —
// esta tabla sólo tiene sentido mientras la fila exista: nace cuando algo se
// pausa y se borra al despertar (`ExecutionSource.consume`), misma
// idempotencia que `waits`/`run_checkpoints` en v1.
//
// `wait_until`/`checkpoint` son JSON crudo — `wait_until` es un
// `WaitConditionProps` completo (on/when/whenText/resumeWith), `checkpoint`
// es opaco para el engine (lo que sea que el Provider haya guardado). No se
// modelan columna por columna: son las mismas dos interfaces de TS ya
// tipadas en engine-v2, partirlas en columnas sólo agregaría una segunda
// fuente de verdad para el mismo shape.
//
// Sin FK a `projects`/`tasks` — mismo criterio que el resto de las tablas
// de este archivo (`agent_memories`, `chat_sessions`): no hay FKs entre las
// entidades principales hoy.

const migration: Migration = {
  id: '080-engine-v2-executions',
  description: 'Crea engine_v2_executions — backing durable de Execution `waiting` (engine-v2)',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS engine_v2_executions (
        id          TEXT PRIMARY KEY NOT NULL,
        task_id     TEXT,
        pipeline_id TEXT,
        do_id       TEXT,
        agent_id    TEXT NOT NULL,
        project_id  TEXT,
        status      TEXT NOT NULL DEFAULT 'waiting',
        wait_until  TEXT NOT NULL,
        checkpoint  TEXT,
        started_at  TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_engine_v2_executions_task
        ON engine_v2_executions(task_id)
    `)
  },
}

export default migration
