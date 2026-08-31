// El orden de las respuestas del tail.

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHostLogTail } from '../api'

const fetchLogs = vi.fn<(c: unknown, q: string) => Promise<AgentHostLogTail>>()

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchLogs: (c: unknown, q: string) => fetchLogs(c, q),
  }
})

vi.mock('../connection', () => ({
  isAgentHostSelected: () => true,
  selectedAgentHostClient: () => ({}),
  selectedAgentHostUrl: () => 'http://localhost:3012',
}))

function tail(msg: string): AgentHostLogTail {
  return { file: '/x.log', truncated: false, lines: [{ raw: msg, msg }] }
}

describe('AgentHostLogsView', () => {
  beforeEach(() => {
    fetchLogs.mockReset()
  })

  it('una respuesta que llega tarde no pisa a una más nueva', async () => {
    // El refresco es cada 5s y el timeout de 10s: contra un agent-host lento
    // las respuestas se cruzan, y sin secuencia el tail sin filtrar (viejo,
    // lento) sobrescribía el filtrado que el operador acaba de pedir.
    const slow = Promise.withResolvers<AgentHostLogTail>()
    fetchLogs.mockImplementationOnce(() => slow.promise)
    fetchLogs.mockImplementationOnce(async () => tail('nuevo'))

    const { default: View } = await import('../AgentHostLogsView.vue')
    const wrapper = mount(View)
    await flushPromises()

    // El filtro sale AUNQUE el primero siga en vuelo — no se descarta.
    wrapper.findComponent({ name: 'AgentHostLogsCard' }).vm.$emit('query', 'error')
    await flushPromises()

    slow.resolve(tail('viejo'))
    await flushPromises()

    expect(wrapper.text()).toContain('nuevo')
    expect(wrapper.text()).not.toContain('viejo')
  })

  it('el filtro que el operador tipea siempre dispara un pedido', async () => {
    const pending = Promise.withResolvers<AgentHostLogTail>()
    fetchLogs.mockImplementationOnce(() => pending.promise)
    fetchLogs.mockImplementationOnce(async () => tail('filtrado'))

    const { default: View } = await import('../AgentHostLogsView.vue')
    const wrapper = mount(View)
    await flushPromises()

    wrapper.findComponent({ name: 'AgentHostLogsCard' }).vm.$emit('query', 'error')
    await flushPromises()

    expect(fetchLogs).toHaveBeenCalledTimes(2)
    expect(fetchLogs.mock.calls[1]?.[1]).toBe('error')
    pending.resolve(tail('viejo'))
  })
})
