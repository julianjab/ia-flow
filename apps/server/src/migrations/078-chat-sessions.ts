import type { Migration } from './runner.js'

// Persistencia del asistente conversacional (bubble button de apps/web): cada
// sesión de chat es una "task" sintética para el engine (ver
// ChatSessionSource en @ia-flow/issue-sources), y sus mensajes son los
// "comentarios" que loadComments/postComment le sirven al pipeline —
// mismo mecanismo que {{task.comments}} usa para cualquier otro source.
//
// Sólo ESTRUCTURA: las tablas nacen vacías. El agente que responde y la
// regla que lo dispara viven en un YAML versionado con el repo
// (apps/server/src/system-agents/), no acá — ver la regla de migraciones
// del CLAUDE.md raíz.
//
// Sin FK a `projects`/`tasks`: mismo criterio que `agent_memories`/
// `task_annotations` — no hay FKs entre las entidades principales hoy.

const migration: Migration = {
  id: '078-chat-sessions',
  description: 'Crea chat_sessions y chat_messages para el asistente conversacional',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id         TEXT PRIMARY KEY NOT NULL,
        project_id TEXT,
        task_id    TEXT,
        working    INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id         TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        author     TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session
        ON chat_messages(session_id, created_at)
    `)
  },
}

export default migration
