import { describe, expect, test } from 'bun:test'
import { ChatSessionSource } from '../ChatSessionSource.js'
import { ChatSessionTaskSource } from '../ChatSessionTaskSource.js'
import type { ChatMessageRecord, ChatSessionRecord, ChatSessionStore } from '../contract.js'
import { CHAT_SESSION_STATUS } from '../contract.js'

function fakeStore(): ChatSessionStore & {
  sessions: Map<string, ChatSessionRecord>
  messages: Map<string, ChatMessageRecord[]>
} {
  const sessions = new Map<string, ChatSessionRecord>()
  const messages = new Map<string, ChatMessageRecord[]>()
  return {
    sessions,
    messages,
    async getById(id) {
      return sessions.get(id) ?? null
    },
    async ensure(id, opts) {
      const existing = sessions.get(id)
      if (existing) {
        const updated = { ...existing, projectId: opts?.projectId, taskId: opts?.taskId }
        sessions.set(id, updated)
        return updated
      }
      const session: ChatSessionRecord = {
        id,
        projectId: opts?.projectId,
        taskId: opts?.taskId,
        working: false,
        createdAt: new Date().toISOString(),
      }
      sessions.set(id, session)
      return session
    },
    async setWorking(id, working) {
      const s = sessions.get(id)
      if (s) s.working = working
    },
    async listMessages(sessionId) {
      return messages.get(sessionId) ?? []
    },
    async appendMessage(sessionId, author, body) {
      const message: ChatMessageRecord = {
        id: crypto.randomUUID(),
        sessionId,
        author,
        body,
        createdAt: new Date().toISOString(),
      }
      messages.set(sessionId, [...(messages.get(sessionId) ?? []), message])
      return message
    },
  }
}

describe('ChatSessionSource', () => {
  test('getItems y watch nunca exponen sesiones al daemon', async () => {
    const store = fakeStore()
    await store.ensure('s1')
    const source = new ChatSessionSource(store)
    expect(await source.getItems()).toEqual([])
    const disposable = source.watch(
      () => {
        throw new Error('watch no debería emitir nada')
      },
      { projectId: 'p1', mode: 'webhook' },
    )
    disposable.dispose()
  })

  test('getItemById arma un SourceItem con el status fijo', async () => {
    const store = fakeStore()
    await store.ensure('s1')
    await store.appendMessage('s1', 'user', '¿por qué falló la tarea X?')
    const source = new ChatSessionSource(store)
    const item = await source.getItemById('s1')
    expect(item?.status).toBe(CHAT_SESSION_STATUS)
    expect(item?.title).toContain('por qué falló')
  })

  test('getItemById devuelve null si la sesión no existe', async () => {
    const source = new ChatSessionSource(fakeStore())
    expect(await source.getItemById('nope')).toBeNull()
  })

  test('loadComments refleja los mensajes de la sesión en orden, con autor', async () => {
    const store = fakeStore()
    await store.ensure('s1')
    await store.appendMessage('s1', 'user', 'primero')
    await store.appendMessage('s1', 'assistant', 'segundo')
    const source = new ChatSessionSource(store)
    const comments = await source.loadComments({ id: 's1' } as never)
    expect(comments.map((c) => ({ body: c.body, author: c.author }))).toEqual([
      { body: 'primero', author: 'user' },
      { body: 'segundo', author: 'assistant' },
    ])
  })

  test('getItemById expone projectId/taskId como contexto en la descripción', async () => {
    const store = fakeStore()
    await store.ensure('s1', { projectId: 'proj-1', taskId: 'task-1' })
    const source = new ChatSessionSource(store)
    const item = await source.getItemById('s1')
    expect(item?.meta?.description).toContain('proj-1')
    expect(item?.meta?.description).toContain('task-1')
  })

  test('getItemById sin proyecto/tarea activos avisa que es una vista global', async () => {
    const store = fakeStore()
    await store.ensure('s1')
    const source = new ChatSessionSource(store)
    const item = await source.getItemById('s1')
    expect(item?.meta?.description).toContain('vista global')
  })

  test('ensure actualiza el contexto en cada mensaje ("último gana")', async () => {
    const store = fakeStore()
    await store.ensure('s1', { projectId: 'proj-1' })
    await store.ensure('s1', { projectId: 'proj-2', taskId: 'task-2' })
    const session = await store.getById('s1')
    expect(session).toEqual(expect.objectContaining({ projectId: 'proj-2', taskId: 'task-2' }))
  })

  test('postComment persiste el mensaje y dispara el broadcast', async () => {
    const store = fakeStore()
    await store.ensure('s1')
    const events: object[] = []
    const taskSource = new ChatSessionTaskSource(store, (msg) => events.push(msg))
    await taskSource.postComment({ id: 's1' } as never, 'hola')
    expect(await store.listMessages('s1')).toHaveLength(1)
    expect(events).toEqual([
      expect.objectContaining({ type: 'assistant:message', sessionId: 's1', body: 'hola' }),
    ])
  })

  test('postComment con target none no escribe nada', async () => {
    const store = fakeStore()
    await store.ensure('s1')
    const taskSource = new ChatSessionTaskSource(store, () => {})
    await taskSource.postComment({ id: 's1' } as never, 'hola', 'none')
    expect(await store.listMessages('s1')).toHaveLength(0)
  })
})
