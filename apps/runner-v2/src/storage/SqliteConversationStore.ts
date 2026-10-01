/**
 * `ConversationStore` sobre la misma base que la actividad del runner (`activityStore.ts`): dos
 * tablas, la conversación y sus mensajes. Las propuestas van como JSON y las tareas como refs.
 */
import type { Database } from 'bun:sqlite'
import {
  type AssistantConversationSummary,
  type AssistantProposal,
  type AssistantScope,
  DEFAULT_ASSISTANT_AGENT,
} from '@ia-flow/shared'
import {
  type ConversationStore,
  type StoredConversation,
  type StoredTurn,
  scopeKey,
} from '../assistant/ConversationStore.js'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS assistant_conversation (
    id           TEXT PRIMARY KEY,
    github_login TEXT NOT NULL,
    scope_key    TEXT NOT NULL,
    scope_json   TEXT NOT NULL,
    title        TEXT NOT NULL,
    agent        TEXT NOT NULL DEFAULT 'assistant',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS assistant_conversation_owner
    ON assistant_conversation (github_login, scope_key, updated_at);
  CREATE TABLE IF NOT EXISTS assistant_message (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES assistant_conversation (id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    proposals_json  TEXT NOT NULL,
    tasks_json      TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS assistant_message_conversation
    ON assistant_message (conversation_id, seq);
`

interface ConversationRow {
  id: string
  scope_json: string
  agent: string
  title: string
  created_at: string
  updated_at: string
  messages: number
}

interface MessageRow {
  role: 'user' | 'assistant'
  content: string
  proposals_json: string
  tasks_json: string
  created_at: string
}

const DEFAULT_LIMIT = 30

function summary(row: ConversationRow): AssistantConversationSummary {
  return {
    id: row.id,
    scope: JSON.parse(row.scope_json) as AssistantScope,
    agent: row.agent,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    messages: row.messages,
  }
}

const SUMMARY_SELECT = `
  SELECT c.id, c.scope_json, c.agent, c.title, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM assistant_message m WHERE m.conversation_id = c.id) AS messages
  FROM assistant_conversation c`

export class SqliteConversationStore implements ConversationStore {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec(SCHEMA)
    // Una base de antes de que el asistente tuviera varios agentes: las suyas son del de siempre.
    const columns = database
      .query<{ name: string }, []>('PRAGMA table_info(assistant_conversation)')
      .all()
    if (!columns.some((column) => column.name === 'agent')) {
      database.exec(
        `ALTER TABLE assistant_conversation ADD COLUMN agent TEXT NOT NULL DEFAULT '${DEFAULT_ASSISTANT_AGENT}'`,
      )
    }
  }

  create(
    login: string,
    scope: AssistantScope,
    title: string,
    agent: string = DEFAULT_ASSISTANT_AGENT,
  ): string {
    const id = globalThis.crypto.randomUUID()
    const at = this.now().toISOString()
    this.database
      .query(
        `INSERT INTO assistant_conversation
           (id, github_login, scope_key, scope_json, title, agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, login, scopeKey(scope), JSON.stringify(scope), title, agent, at, at)
    return id
  }

  owns(id: string, login: string, agent?: string): boolean {
    const row = this.database
      .query<{ agent: string }, [string, string]>(
        'SELECT agent FROM assistant_conversation WHERE id = ? AND github_login = ?',
      )
      .get(id, login)
    return row !== null && (agent === undefined || row.agent === agent)
  }

  append(id: string, turns: StoredTurn[]): void {
    const at = this.now().toISOString()
    const insert = this.database.query(
      `INSERT INTO assistant_message
         (conversation_id, role, content, proposals_json, tasks_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    this.database.transaction(() => {
      for (const turn of turns) {
        insert.run(
          id,
          turn.role,
          turn.content,
          JSON.stringify(turn.proposals),
          JSON.stringify(turn.tasks),
          at,
        )
      }
      this.database
        .query('UPDATE assistant_conversation SET updated_at = ? WHERE id = ?')
        .run(at, id)
    })()
  }

  list(
    login: string,
    scope?: AssistantScope,
    limit = DEFAULT_LIMIT,
  ): AssistantConversationSummary[] {
    const rows = scope
      ? this.database
          .query<ConversationRow, [string, string, number]>(
            `${SUMMARY_SELECT} WHERE c.github_login = ? AND c.scope_key = ?
             ORDER BY c.updated_at DESC LIMIT ?`,
          )
          .all(login, scopeKey(scope), limit)
      : this.database
          .query<ConversationRow, [string, number]>(
            `${SUMMARY_SELECT} WHERE c.github_login = ? ORDER BY c.updated_at DESC LIMIT ?`,
          )
          .all(login, limit)
    return rows.map(summary)
  }

  get(id: string, login: string): StoredConversation | undefined {
    const row = this.database
      .query<ConversationRow, [string, string]>(
        `${SUMMARY_SELECT} WHERE c.id = ? AND c.github_login = ?`,
      )
      .get(id, login)
    if (!row) return undefined
    const thread = this.database
      .query<MessageRow, [string]>(
        `SELECT role, content, proposals_json, tasks_json, created_at
         FROM assistant_message WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(id)
      .map((message) => ({
        role: message.role,
        content: message.content,
        created_at: message.created_at,
        proposals: JSON.parse(message.proposals_json) as AssistantProposal[],
        tasks: JSON.parse(message.tasks_json) as string[],
      }))
    return { ...summary(row), thread }
  }

  remove(id: string, login: string): boolean {
    return (
      this.database
        .query('DELETE FROM assistant_conversation WHERE id = ? AND github_login = ?')
        .run(id, login).changes > 0
    )
  }

  prune(cutoff: string): void {
    this.database.query('DELETE FROM assistant_conversation WHERE updated_at < ?').run(cutoff)
  }
}
