import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendTaskChatMessage = vi.fn()
vi.mock('@/features/tasks/chatApi', () => ({
  sendTaskChatMessage: (...a: unknown[]) => sendTaskChatMessage(...a),
}))

import TaskCommandBar from '@/features/tasks/TaskCommandBar.vue'
import { useTaskChatStore } from '@/features/tasks/taskChatStore'

const TASKS = [{ id: 't1', title: 'Arreglar bug', status: 'In Progress', tags: [] }]

beforeEach(() => {
  setActivePinia(createPinia())
  sendTaskChatMessage.mockReset()
})

function mountBar() {
  return mount(TaskCommandBar, {
    props: { tasks: TASKS, projectId: 'p1' },
  })
}

describe('TaskCommandBar', () => {
  it('arranca colapsada — el toggle de "Preguntas rápidas" no muestra la lista hasta tocarlo', async () => {
    const w = mountBar()
    expect(w.find('[data-testid="chat-suggestions-toggle"]').exists()).toBe(true)
    expect(w.findAll('.command-suggestion')).toHaveLength(0)

    await w.find('[data-testid="chat-suggestions-toggle"]').trigger('click')
    expect(w.findAll('.command-suggestion')).toHaveLength(4)
  })

  it('tocar una sugerencia la envía como primer mensaje y colapsa la lista', async () => {
    sendTaskChatMessage.mockResolvedValue({ reply: 'ok', scope: { type: 'project' }, actions: [] })
    const w = mountBar()
    await w.find('[data-testid="chat-suggestions-toggle"]').trigger('click')
    await w.find('.command-suggestion').trigger('click')
    await flushPromises()
    expect(sendTaskChatMessage).toHaveBeenCalledTimes(1)
    expect(sendTaskChatMessage.mock.calls[0]?.[0]?.projectId).toBe('p1')
    expect(w.findAll('.command-suggestion')).toHaveLength(0)
  })

  it('enviar por el input y ver la respuesta de scope proyecto', async () => {
    sendTaskChatMessage.mockResolvedValue({
      reply: 'Nada bloqueado.',
      scope: { type: 'project' },
      actions: [],
    })
    const w = mountBar()
    await w.find('[data-testid="chat-input"]').setValue('¿Qué está bloqueado?')
    await w.find('[data-testid="chat-send"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="chat-project-reply"]').text()).toBe('Nada bloqueado.')
  })

  it('una respuesta de scope tarea NO se dibuja en la barra', async () => {
    sendTaskChatMessage.mockResolvedValue({
      reply: 'Está bloqueada por #99',
      scope: { type: 'task', taskId: 't1' },
      actions: [],
    })
    const w = mountBar()
    await w.find('[data-testid="chat-input"]').setValue('¿y esta tarea?')
    await w.find('[data-testid="chat-send"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="chat-project-reply"]').exists()).toBe(false)
  })

  it('con acciones pendientes aparece la barra Aplicar/Descartar y Aplicar emite `apply`', async () => {
    sendTaskChatMessage.mockResolvedValue({
      reply: 'ok',
      scope: { type: 'project' },
      actions: [{ type: 'tag', taskId: 't1', tags: ['urgente'] }],
    })
    const w = mountBar()
    await w.find('[data-testid="chat-input"]').setValue('etiqueta esto')
    await w.find('[data-testid="chat-send"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="chat-action-block"]').exists()).toBe(true)
    await w.find('[data-testid="chat-apply"]').trigger('click')
    expect(w.emitted('apply')?.[0]?.[0]).toEqual([{ type: 'tag', taskId: 't1', tags: ['urgente'] }])
  })

  it('Descartar limpia la propuesta sin emitir `apply`', async () => {
    sendTaskChatMessage.mockResolvedValue({
      reply: 'ok',
      scope: { type: 'project' },
      actions: [{ type: 'tag', taskId: 't1', tags: ['urgente'] }],
    })
    const w = mountBar()
    await w.find('[data-testid="chat-input"]').setValue('etiqueta esto')
    await w.find('[data-testid="chat-send"]').trigger('click')
    await flushPromises()
    await w.find('[data-testid="chat-discard"]').trigger('click')
    expect(w.emitted('apply')).toBeUndefined()
    expect(w.find('[data-testid="chat-action-block"]').exists()).toBe(false)
  })

  it('un fallo muestra la línea ✕ y "reintentar"', async () => {
    sendTaskChatMessage.mockRejectedValue(new Error('boom'))
    const w = mountBar()
    await w.find('[data-testid="chat-input"]').setValue('hola')
    await w.find('[data-testid="chat-send"]').trigger('click')
    await flushPromises()
    expect(w.find('.command-error-line').text()).toContain('boom')
    expect(w.find('.command-error-retry').text()).toContain('reintentar')
  })

  it('"reintentar" reenvía EXACTAMENTE el mensaje que falló, incluso en el primer intento', async () => {
    sendTaskChatMessage.mockRejectedValueOnce(new Error('boom'))
    const w = mountBar()
    await w.find('[data-testid="chat-input"]').setValue('¿qué está bloqueado?')
    await w.find('[data-testid="chat-send"]').trigger('click')
    await flushPromises()

    sendTaskChatMessage.mockResolvedValueOnce({
      reply: 'ok',
      scope: { type: 'project' },
      actions: [],
    })
    await w.find('.command-error-retry').trigger('click')
    await flushPromises()

    expect(sendTaskChatMessage.mock.calls[1]?.[0]?.message).toBe('¿qué está bloqueado?')
  })

  it('"Detener" aborta el pedido en vuelo', async () => {
    sendTaskChatMessage.mockImplementation(
      (_payload: unknown, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const store = useTaskChatStore()
    const w = mountBar()
    await w.find('[data-testid="chat-input"]').setValue('hola')
    await w.find('[data-testid="chat-send"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="chat-stop"]').exists()).toBe(true)
    await w.find('[data-testid="chat-stop"]').trigger('click')
    await flushPromises()
    expect(store.busy).toBe(false)
    expect(store.error).toBeNull()
  })
})
