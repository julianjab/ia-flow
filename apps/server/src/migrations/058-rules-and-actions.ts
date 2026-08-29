import type { Migration } from './runner.js'

// Crea las tres tablas del modelo eventos/reglas/acciones.
//
// Sólo ESTRUCTURA: nacen vacías. No se siembra ninguna regla — las escribe el
// operador desde la UI, o vienen en el YAML de un deploy headless, así que
// sembrarlas haría que actualizar el producto pise lo que alguien editó (ver la
// regla de migraciones en el CLAUDE.md de la raíz).
//
// `rules`
//   `project_id` / `repo_name` NULL = sin restricción, misma semántica que en
//   `agents`. Son referencias lógicas y no FKs, igual que `agents.repo_name`:
//   validarlas es trabajo del CRUD, que puede dar un error legible en vez de un
//   `FOREIGN KEY constraint failed`.
//   `on_types`, `when_conditions` y `actions` son JSON. `actions` no se
//   normaliza a una tabla hija a propósito: el `do[]` se lee y se escribe
//   siempre entero, nunca por fila, y una tabla aparte sólo agregaría un join y
//   la posibilidad de que el orden se pierda.
//
// `action_runs`
//   La razón de que exista: una acción `http` no tiene ninguna de las redes que
//   tiene un run de agente (ni `execution_logs`, ni el flag `working` en la
//   fuente). Si el proceso se reinicia entre "el evento llegó" y "la llamada
//   salió", la llamada se perdió y nadie se entera. Como efecto lateral da el
//   panel de "qué disparó qué".
//
// `processed_events`
//   Dedupe por identidad del evento. Un delivery de GitHub que se reintenta
//   —cosa que GitHub hace— traería el mismo `X-GitHub-Delivery` y dispararía
//   las reglas dos veces. `expires_at` existe porque esta tabla crece sin
//   techo: es un registro operativo, no un log de auditoría.

const migration: Migration = {
  id: '058-rules-and-actions',
  description: 'Create rules, action_runs and processed_events tables',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS rules (
        id              TEXT PRIMARY KEY NOT NULL,
        name            TEXT,
        description     TEXT,
        on_types        TEXT NOT NULL,
        project_id      TEXT,
        repo_name       TEXT,
        when_conditions TEXT,
        when_text       TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        position        INTEGER NOT NULL DEFAULT 0,
        exclusive       INTEGER NOT NULL DEFAULT 0,
        actions         TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      )
    `)
    // El matcher lee por ámbito y ordena por posición; este índice cubre el
    // caso más común (las reglas de un proyecto) y las globales caen en el
    // mismo árbol con project_id NULL.
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_rules_scope
        ON rules(project_id, position)
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS action_runs (
        id          TEXT PRIMARY KEY NOT NULL,
        rule_id     TEXT NOT NULL,
        event_id    TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        project_id  TEXT,
        position    INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        status      TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        error       TEXT,
        result      TEXT,
        created_at  TEXT NOT NULL,
        started_at  TEXT,
        finished_at TEXT
      )
    `)
    // Dos lecturas distintas: "qué está pendiente" (el reintento tras un
    // reinicio) y "qué disparó este evento" (el panel).
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_action_runs_status
        ON action_runs(status, created_at)
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_action_runs_event
        ON action_runs(event_id)
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id     TEXT PRIMARY KEY NOT NULL,
        event_type   TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        expires_at   TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_processed_events_expiry
        ON processed_events(expires_at)
    `)
  },
}

export default migration
