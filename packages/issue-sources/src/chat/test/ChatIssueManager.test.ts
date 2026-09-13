import { describe, expect, test } from 'bun:test'
import { ChatIssueManager } from '../ChatIssueManager.js'
import { ChatSessionSource } from '../ChatSessionSource.js'
import type { ChatMessageRecord, ChatSessionRecord, ChatSessionStore } from '../contract.js'

function fakeStore(): ChatSessionStore & { messages: Map<string, ChatMessageRecord[]> } {
  const sessions = new Map<string, ChatSessionRecord>()
  const messages = new Map<string, ChatMessageRecord[]>()
  return {
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

describe('ChatIssueManager', () => {
  test('expone el scope fijo como projectId, sin depender de ningún Project real', () => {
    const manager = new ChatIssueManager('__chat__', new ChatSessionSource(fakeStore()), () => {})
    expect(manager.projectId).toBe('__chat__')
  })

  test('start() es un no-op — nunca lo llama el daemon, este manager no sale de buildManagers()', () => {
    const manager = new ChatIssueManager('__chat__', new ChatSessionSource(fakeStore()), () => {})
    const disposable = manager.start(async () => undefined)
    expect(() => disposable.dispose()).not.toThrow()
  })

  test('getTransitionManager delega en ChatSessionSource con el broadcast dado', async () => {
    const store = fakeStore()
    await store.ensure('s1')
    const events: object[] = []
    const manager = new ChatIssueManager('__chat__', new ChatSessionSource(store), (msg) =>
      events.push(msg),
    )
    const transitions = manager.getTransitionManager({ id: 's1' } as never)
    await transitions.postComment?.({ id: 's1' } as never, 'hola')
    expect(events).toEqual([
      expect.objectContaining({ type: 'assistant:message', sessionId: 's1' }),
    ])
  })

  test('loadComments delega en ChatSessionSource', async () => {
    const store = fakeStore()
    await store.ensure('s1')
    await store.appendMessage('s1', 'user', 'hola')
    const manager = new ChatIssueManager('__chat__', new ChatSessionSource(store), () => {})
    const comments = await manager.loadComments({ id: 's1' } as never)
    expect(comments).toEqual([expect.objectContaining({ body: 'hola', author: 'user' })])
  })
})
