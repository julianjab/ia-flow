import FinishedTodayPanel from '@/components/FinishedTodayPanel.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let rows: Array<Record<string, unknown>> = []
let throws = false
const fetchExecutions = vi.fn(async () => {
  if (throws) throw new Error('502')
  return rows
})
vi.mock('@/features/executions/api', () => ({
  fetchExecutions: (...a: unknown[]) => fetchExecutions(...(a as [])),
}))

function run(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    projectId: 'p1',
    taskId: '#1240',
    taskTitle: 'Agregar SID',
    agentId: 'implementer',
    providerId: 'anthropic-api',
    startedAt: '2026-09-07T09:00:00.000Z',
    finishedAt: '2026-09-07T09:06:00.000Z',
    outcome: 'success',
    errorMsg: null,
    stopReason: null,
    ...over,
  }
}

beforeEach(() => {
  rows = []
  throws = false
  fetchExecutions.mockClear()
})

async function mountPanel() {
  const w = mount(FinishedTodayPanel, { props: { projectId: 'p1' } })
  await flushPromises()
  return w
}

describe('FinishedTodayPanel', () => {
  it('lista lo terminado y lo que falló va primero', async () => {
    // Es lo único de esta lista que puede pedir algo; un éxito no pide nada.
    rows = [
      run({ id: 'ok', outcome: 'success' }),
      run({ id: 'bad', outcome: 'error', failureClass: 'tests', taskId: '#1246' }),
    ]
    const w = await mountPanel()
    const texts = w.findAll('.ft-row__text').map((n) => n.text())
    expect(texts[0]).toContain('#1246')
  })

  it('un run que sigue corriendo NO entra: es del panel de arriba', async () => {
    // Repetirlo sería la misma fila dos veces en la misma columna.
    rows = [run({ id: 'live', finishedAt: null, outcome: null })]
    const w = await mountPanel()
    expect(w.find('.ft-panel').exists()).toBe(false)
  })

  it('si no se pudo consultar, se calla — no afirma un cero', async () => {
    throws = true
    const w = await mountPanel()
    expect(w.find('.ft-panel').exists()).toBe(false)
  })

  it('pide sólo desde el arranque del día', async () => {
    rows = [run()]
    await mountPanel()
    const params = fetchExecutions.mock.calls.at(-1)?.[0] as { from: string }
    expect(new Date(params.from).getHours()).toBe(0)
  })

  it('una fila abre su run', async () => {
    rows = [run({ id: 'e9' })]
    const w = await mountPanel()
    await w.get('.ft-row').trigger('click')
    expect(w.emitted('open')?.[0]).toEqual(['e9'])
  })
})
