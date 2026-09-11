import type { Database } from 'bun:sqlite'
import type {
  ChatMessage,
  ChatSession,
  IChatSessionRepository,
} from '../../../domain/ports/IChatSessionRepository.js'

function rowToSession(r: Record<string, unknown>): ChatSession {
  return {
    id: r.id as string,
    projectId: (r.project_id as string | null) ?? undefined,
    taskId: (r.task_id as string | null) ?? undefined,
    working: Boolean(r.working),
    createdAt: r.created_at as string,
  }
}

function rowToMessage(r: Record<string, unknown>): ChatMessage {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    author: r.author as string,
    body: r.body as string,
    createdAt: r.created_at as string,
  }
}

export class SqliteChatSessionRepository implements IChatSessionRepository {
  constructor(private db: Database) {}

  getById(id: string): ChatSession | null {
    const row = this.db.query('SELECT * FROM chat_sessions WHERE id = ? LIMIT 1').get(id) as Record<
      string,
      unknown
    > | null
    return row ? rowToSession(row) : null
  }

  ensure(id: string, opts?: { projectId?: string; taskId?: string }): ChatSession {
    const existing = this.getById(id)
    if (existing) return existing
    const session: ChatSession = {
      id,
      projectId: opts?.projectId,
      taskId: opts?.taskId,
      working: false,
      createdAt: new Date().toISOString(),
    }
    this.db.run(
      `INSERT INTO chat_sessions (id, project_id, task_id, working, created_at)
       VALUES (?, ?, ?, 0, ?)`,
      [session.id, session.projectId ?? null, session.taskId ?? null, session.createdAt],
    )
    return session
  }

  setWorking(id: string, working: boolean): void {
    this.db.run('UPDATE chat_sessions SET working = ? WHERE id = ?', [working ? 1 : 0, id])
  }

  listMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .query('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC')
      .all(sessionId) as Record<string, unknown>[]
    return rows.map(rowToMessage)
  }

  appendMessage(sessionId: string, author: string, body: string): ChatMessage {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId,
      author,
      body,
      createdAt: new Date().toISOString(),
    }
    this.db.run(
      `INSERT INTO chat_messages (id, session_id, author, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [message.id, message.sessionId, message.author, message.body, message.createdAt],
    )
    return message
  }
}
