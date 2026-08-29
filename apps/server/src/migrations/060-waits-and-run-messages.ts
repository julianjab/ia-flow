import type { Migration } from './runner.js'

// Crea `waits` y `run_messages`: lo único que sobrevive al final de un run.
//
// Sólo estructura, ambas nacen vacías — las filas las escribe un agente en
// runtime (`wait_for_event`) o un productor de mensajes (Slack, la API).
//
// `waits`
//   Es una regla efímera, de un solo uso, con scope de task: se evalúa con el
//   mismo matcher, se consume al matchear y vence. `expires_at` es NOT NULL a
//   propósito — un CI que nunca corre porque el workflow tenía un error de
//   sintaxis dejaría la task esperando para siempre, y una columna nullable
//   invita a que alguien la deje vacía "por ahora".
//
//   `checkpoint` es lo que separa una espera de una PAUSA: NULL cuando no hay
//   posición que conservar, y el estado serializado del run cuando sí. Es un
//   blob opaco: cada provider decide qué significa "el punto donde va" (para
//   `anthropic-api`, el array de mensajes del loop; un provider de terminal no
//   lo necesita porque su proceso sigue vivo).
//
// `run_messages`
//   La cola que se drena al tope del loop. Vale por sí sola —dirigir un agente
//   en vuelo es útil sin pausar nada— y es la primera pieza de una pausa.
//   `run_id` es NULLABLE porque un mensaje puede llegar antes de que arranque
//   el run que lo va a leer.
//
// Sin FKs a `agents` ni a `projects`, igual que `agent_memories`: hoy no hay
// FKs entre las entidades principales, y una espera huérfana de un agente
// borrado es preferible a un DELETE que falla.

const migration: Migration = {
  id: '060-waits-and-run-messages',
  description: 'Create waits (one-shot event subscriptions) and run_messages tables',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS waits (
        id              TEXT PRIMARY KEY NOT NULL,
        project_id      TEXT NOT NULL,
        task_id         TEXT NOT NULL,
        agent_id        TEXT NOT NULL,
        on_types        TEXT NOT NULL,
        when_conditions TEXT,
        expires_at      TEXT NOT NULL,
        resume_with     TEXT,
        created_by_run  TEXT,
        checkpoint      TEXT,
        created_at      TEXT NOT NULL
      )
    `)
    // Dos lecturas: "qué espera este proyecto" (el matcher, por evento) y "qué
    // venció" (el barrido). Una task no puede tener dos esperas vivas —lo
    // garantiza el engine, no un índice único: dos filas serían un bug, pero
    // fallar el INSERT dejaría al run sin cerrar.
    db.run('CREATE INDEX IF NOT EXISTS idx_waits_project ON waits(project_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_waits_task ON waits(task_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_waits_expiry ON waits(expires_at)')

    db.run(`
      CREATE TABLE IF NOT EXISTS run_messages (
        id           TEXT PRIMARY KEY NOT NULL,
        task_id      TEXT NOT NULL,
        run_id       TEXT,
        body         TEXT NOT NULL,
        author       TEXT,
        source       TEXT,
        created_at   TEXT NOT NULL,
        delivered_at TEXT
      )
    `)
    // El loop pregunta "¿qué hay pendiente para esta task?" en cada turno, así
    // que el índice cubre las dos columnas de esa consulta.
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_run_messages_pending ON run_messages(task_id, delivered_at)',
    )
  },
}

export default migration
