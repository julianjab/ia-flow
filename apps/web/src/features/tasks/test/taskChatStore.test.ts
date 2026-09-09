import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendTaskChatMessage = vi.fn()
vi.mock('@/features/tasks/chatApi', () => ({
  sendTaskChatMessage: (...a: unknown[]) => sendTaskChatMessage(...a),
}))

import { useTaskChatStore } from '../taskChatStore'

const TASKS = [{ id: 't1', title: 'Arreglar bug', status: 'In Progress', tags: [] }]

beforeEach(() => {
  setActivePinia(createPinia())
  sendTaskChatMessage.mockReset()
})

describe('taskChatStore', () => {
  it('ask() empuja el turno al historial y guarda la propuesta en pending', async () => {
    sendTaskChatMessage.mockResolvedValue({
      reply: 'Nada bloqueado.',
      scope: { type: 'project' },
      actions: [],
    })
    const s = useTaskChatStore()
    await s.ask({ projectId: 'p1', message: '¿Qué está bloqueado?', tasks: TASKS })
    expect(s.history).toEqual([
      { role: 'user', content: '¿Qué está bloqueado?' },
      { role: 'assistant', content: 'Nada bloqueado.' },
    ])
    expect(s.pending?.reply).toBe('Nada bloqueado.')
    expect(s.busy).toBe(false)
  })

  it('ask() manda el history previo, sin el mensaje nuevo (viaja aparte)', async () => {
    sendTaskChatMessage.mockResolvedValue({ reply: 'ok', scope: { type: 'project' }, actions: [] })
    const s = useTaskChatStore()
    await s.ask({ projectId: 'p1', message: 'primero', tasks: TASKS })
    await s.ask({ projectId: 'p1', message: 'segundo', tasks: TASKS })
    const secondCall = sendTaskChatMessage.mock.calls[1]?.[0]
    expect(secondCall.message).toBe('segundo')
    expect(secondCall.history).toEqual([
      { role: 'user', content: 'primero' },
      { role: 'assistant', content: 'ok' },
    ])
  })

  it('un fallo deja error seteado y pending en null', async () => {
    sendTaskChatMessage.mockRejectedValue(new Error('boom'))
    const s = useTaskChatStore()
    await s.ask({ projectId: 'p1', message: 'hola', tasks: TASKS })
    expect(s.error).toBe('boom')
    expect(s.pending).toBeNull()
  })

  it('pendingActionsByTask agrupa las acciones (menos reorder) por taskId', async () => {
    sendTaskChatMessage.mockResolvedValue({
      reply: 'ok',
      scope: { type: 'project' },
      actions: [
        { type: 'tag', taskId: 't1', tags: ['x'] },
        { type: 'note', taskId: 't1', text: 'nota' },
        { type: 'reorder', taskIds: ['t1'] },
      ],
    })
    const s = useTaskChatStore()
    await s.ask({ projectId: 'p1', message: 'hola', tasks: TASKS })
    expect(s.pendingActionsByTask.t1).toHaveLength(2)
    expect(s.pendingActionsByTask.t1?.map((a) => a.type)).toEqual(['tag', 'note'])
  })

  it('pendingReplyForTask sólo devuelve texto cuando scope es de esa tarea puntual', async () => {
    sendTaskChatMessage.mockResolvedValue({
      reply: 'Está bloqueada por #99',
      scope: { type: 'task', taskId: 't1' },
      actions: [],
    })
    const s = useTaskChatStore()
    await s.ask({ projectId: 'p1', message: 'hola', tasks: TASKS })
    expect(s.pendingReplyForTask('t1')).toBe('Está bloqueada por #99')
    expect(s.pendingReplyForTask('otra')).toBeNull()
  })

  it('discard() limpia la propuesta sin tocar el historial', async () => {
    sendTaskChatMessage.mockResolvedValue({ reply: 'ok', scope: { type: 'project' }, actions: [] })
    const s = useTaskChatStore()
    await s.ask({ projectId: 'p1', message: 'hola', tasks: TASKS })
    s.discard()
    expect(s.pending).toBeNull()
    expect(s.history).toHaveLength(2)
  })

  it('recordHighlights guarda el motivo de sesión, y clearHighlight lo saca', () => {
    const s = useTaskChatStore()
    s.recordHighlights([{ type: 'highlight', taskId: 't1', reason: 'Bloquea al equipo' }])
    expect(s.highlights.t1).toBe('Bloquea al equipo')
    s.clearHighlight('t1')
    expect(s.highlights.t1).toBeUndefined()
  })

  it('reset() borra historial, pending, error y highlights', async () => {
    sendTaskChatMessage.mockResolvedValue({ reply: 'ok', scope: { type: 'project' }, actions: [] })
    const s = useTaskChatStore()
    await s.ask({ projectId: 'p1', message: 'hola', tasks: TASKS })
    s.recordHighlights([{ type: 'highlight', taskId: 't1', reason: 'x' }])
    s.reset()
    expect(s.history).toEqual([])
    expect(s.pending).toBeNull()
    expect(s.highlights).toEqual({})
  })
})
