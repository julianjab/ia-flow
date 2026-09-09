import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import TaskChatRowOverlay from '@/features/tasks/TaskChatRowOverlay.vue'
import { useTaskChatStore } from '@/features/tasks/taskChatStore'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('TaskChatRowOverlay', () => {
  it('no dibuja nada cuando no hay propuesta ni highlight para esa tarea', () => {
    const w = mount(TaskChatRowOverlay, { props: { taskId: 't1' } })
    expect(w.find('.chat-row-overlay').exists()).toBe(false)
  })

  it('dibuja el reply cuando el scope pendiente es esa tarea puntual', async () => {
    const store = useTaskChatStore()
    store.pending = {
      reply: 'Está bloqueada por #99',
      scope: { type: 'task', taskId: 't1' },
      actions: [],
    }
    const w = mount(TaskChatRowOverlay, { props: { taskId: 't1' } })
    expect(w.find('.overlay-reply').text()).toBe('Está bloqueada por #99')
  })

  it('no dibuja el reply de otra tarea', () => {
    const store = useTaskChatStore()
    store.pending = { reply: 'x', scope: { type: 'task', taskId: 'otra' }, actions: [] }
    const w = mount(TaskChatRowOverlay, { props: { taskId: 't1' } })
    expect(w.find('.chat-row-overlay').exists()).toBe(false)
  })

  it('dibuja el chip de tags propuestas con borde distinto (dashed)', () => {
    const store = useTaskChatStore()
    store.pending = {
      reply: 'ok',
      scope: { type: 'project' },
      actions: [{ type: 'tag', taskId: 't1', tags: ['urgente', 'backend'] }],
    }
    const w = mount(TaskChatRowOverlay, { props: { taskId: 't1' } })
    const tags = w.findAll('.overlay-tag-proposed')
    expect(tags.map((t) => t.text())).toEqual(['urgente', 'backend'])
  })

  it('dibuja el texto de una nota propuesta', () => {
    const store = useTaskChatStore()
    store.pending = {
      reply: 'ok',
      scope: { type: 'project' },
      actions: [{ type: 'note', taskId: 't1', text: 'Depende de #99' }],
    }
    const w = mount(TaskChatRowOverlay, { props: { taskId: 't1' } })
    expect(w.find('.overlay-note-text').text()).toBe('Depende de #99')
  })

  it('dibuja el highlight de sesión con su motivo, y el botón lo quita', async () => {
    const store = useTaskChatStore()
    store.recordHighlights([{ type: 'highlight', taskId: 't1', reason: 'Bloquea al equipo' }])
    const w = mount(TaskChatRowOverlay, { props: { taskId: 't1' } })
    expect(w.find('.overlay-highlight-text').text()).toBe('Bloquea al equipo')
    await w.find('.overlay-dismiss').trigger('click')
    expect(store.highlights.t1).toBeUndefined()
  })

  it('reorder no dibuja nada en la fila — sólo afecta el resumen de la barra de comandos', () => {
    const store = useTaskChatStore()
    store.pending = {
      reply: 'ok',
      scope: { type: 'project' },
      actions: [{ type: 'reorder', taskIds: ['t1', 't2'] }],
    }
    const w = mount(TaskChatRowOverlay, { props: { taskId: 't1' } })
    expect(w.find('.chat-row-overlay').exists()).toBe(false)
  })
})
