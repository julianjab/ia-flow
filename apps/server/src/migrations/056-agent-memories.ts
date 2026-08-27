import type { Migration } from './runner.js'

// Crea `agent_memories` — el KV que un agente se lleva de un run al siguiente.
//
// Sólo ESTRUCTURA: la tabla nace vacía y todo lo que termine adentro lo escribe
// un agente en runtime con `memory_store`. No hay nada que sembrar acá (ver la
// regla de migraciones en el CLAUDE.md de la raíz).
//
// `project_id` es TEXT NOT NULL con default `''` y no un NULL opcional porque
// forma parte de la primary key, y en SQLite dos NULL nunca comparan iguales:
// una PK con NULL dejaría que el mismo agente insertara la misma key global N
// veces en vez de pisarla. `''` = memoria global al agente.
//
// Sin FK a `agents`: hoy no hay FKs entre las entidades principales, y un
// agente borrado dejando su memoria huérfana es preferible a un DELETE que
// falla. Sin FTS5: el search del MVP es `LIKE`, y el índice por namespace ya
// acota el scan a las filas de un agente.

const migration: Migration = {
  id: '056-agent-memories',
  description: 'Create agent_memories table (per-agent persistent KV)',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS agent_memories (
        agent_id   TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, project_id, key)
      )
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_agent_memories_namespace
        ON agent_memories(agent_id, project_id)
    `)
  },
}

export default migration
