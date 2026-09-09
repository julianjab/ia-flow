import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskChatDrawer from '@/features/tasks/TaskChatDrawer.vue'

const sendTaskChatMessage = vi.fn()
vi.mock('@/features/tasks/chatApi', () => ({
  sendTaskChatMessage: (...args: unknown[]) => sendTaskChatMessage(...args),
}))

// El drawer se teletransporta al body — igual criterio que `TaskDetailModal`.
const el = (sel: string) => document.body.querySelector(sel)
const need = (sel: string) => {
  const found = el(sel)
  if (!found) throw new Error(`No se encontró ${sel} en el drawer`)
  return found as HTMLElement
}

function mountDrawer(props: Record<string, unknown> = {}) {
  return mount(TaskChatDrawer, {
    props: { open: true, projectId: 'p1', tasks: [], ...props },
    attachTo: document.body,
  })
}

// El drawer vive fuera del árbol del wrapper (Teleport), así que
// `wrapper.find` no lo alcanza — se escribe y se manda contra el DOM real.
async function sendViaInput(text: string) {
  const input = need('.tc-input') as HTMLTextAreaElement
  input.value = text
  input.dispatchEvent(new Event('input'))
  await flushPromises()
  need('.tc-foot').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flushPromises()
}

afterEach(() => {
  document.body.innerHTML = ''
  sendTaskChatMessage.mockReset()
})

describe('TaskChatDrawer', () => {
  it('cerrado no monta nada', () => {
    mountDrawer({ open: false })
    expect(el('.tc-panel')).toBeNull()
  })

  it('arranca con al menos 3 sugerencias tappeables', () => {
    mountDrawer()
    const suggestions = document.body.querySelectorAll('.tc-suggestion')
    expect(suggestions.length).toBeGreaterThanOrEqual(3)
  })

  it('tocar una sugerencia la manda como primer mensaje', async () => {
    sendTaskChatMessage.mockResolvedValue({ reply: 'Nada bloqueado.', actions: [] })
    mountDrawer()
    const first = document.body.querySelector<HTMLButtonElement>('.tc-suggestion')
    first?.click()
    await flushPromises()
    expect(sendTaskChatMessage).toHaveBeenCalledTimes(1)
    const bubbles = document.body.querySelectorAll('.chat-bubble.is-user')
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]?.textContent).toContain(first?.textContent?.trim())
  })

  it('la respuesta con actions dibuja los chips y la barra Aplicar/Descartar', async () => {
    sendTaskChatMessage.mockResolvedValue({
      reply: 'Movela a Done.',
      actions: [
        {
          type: 'set-field',
          itemId: 't1',
          itemTitle: 'Arreglar bug',
          field: 'status',
          value: 'Done',
        },
      ],
    })
    mountDrawer()
    await sendViaInput('¿qué hago con t1?')

    expect(need('.action-chip').textContent).toContain('Done')
    expect(document.body.querySelector('[data-testid="chat-apply"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="chat-discard"]')).not.toBeNull()
  })

  it('Aplicar emite `apply` con las acciones y esconde el bloque', async () => {
    sendTaskChatMessage.mockResolvedValue({
      reply: 'ok',
      actions: [{ type: 'set-field', itemId: 't1', field: 'status', value: 'Done' }],
    })
    const w = mountDrawer()
    await sendViaInput('hola')

    const applyBtn = need('[data-testid="chat-apply"]') as HTMLButtonElement
    applyBtn.click()
    await flushPromises()

    expect(w.emitted('apply')?.[0]?.[0]).toEqual([
      { type: 'set-field', itemId: 't1', field: 'status', value: 'Done' },
    ])
    expect(el('.action-chip')).toBeNull()
  })

  it('Descartar esconde el bloque sin emitir `apply`', async () => {
    sendTaskChatMessage.mockResolvedValue({
      reply: 'ok',
      actions: [{ type: 'set-field', itemId: 't1', field: 'status', value: 'Done' }],
    })
    const w = mountDrawer()
    await sendViaInput('hola')

    const discardBtn = need('[data-testid="chat-discard"]') as HTMLButtonElement
    discardBtn.click()
    await flushPromises()

    expect(w.emitted('apply')).toBeUndefined()
    expect(el('.action-chip')).toBeNull()
  })

  it('un fallo dibuja la línea ✕ y una línea → para reintentar, sin dejar la burbuja del asistente', async () => {
    sendTaskChatMessage.mockRejectedValueOnce(new Error('Anthropic API error 500: boom'))
    mountDrawer()
    await sendViaInput('hola')

    expect(need('.tc-error-line').textContent).toContain('boom')
    expect(need('.tc-error-retry').textContent).toContain('Reintentar')
    expect(document.body.querySelectorAll('.chat-bubble.is-assistant')).toHaveLength(0)

    sendTaskChatMessage.mockResolvedValueOnce({ reply: 'Ahora sí.', actions: [] })
    need('.tc-error-retry').dispatchEvent(new Event('click'))
    await flushPromises()

    expect(el('.tc-error')).toBeNull()
    expect(document.body.querySelectorAll('.chat-bubble.is-assistant')).toHaveLength(1)
  })

  it('Escape cierra el panel', async () => {
    const w = mountDrawer()
    need('.tc-backdrop').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await flushPromises()
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('el botón ✕ cierra el panel', async () => {
    const w = mountDrawer()
    need('.tc-close').dispatchEvent(new Event('click'))
    await flushPromises()
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('reabrir el panel arranca el historial en blanco', async () => {
    sendTaskChatMessage.mockResolvedValue({ reply: 'ok', actions: [] })
    const w = mountDrawer()
    await sendViaInput('hola')
    expect(document.body.querySelectorAll('.chat-bubble').length).toBeGreaterThan(0)

    await w.setProps({ open: false })
    await w.setProps({ open: true })
    await flushPromises()

    expect(document.body.querySelectorAll('.chat-bubble')).toHaveLength(0)
  })
})
