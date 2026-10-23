import type { RunnerLogs as Page, RunnerLogLine } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogsQuery } from '../api'

const getLogs = vi.fn<(q: LogsQuery) => Promise<Page | null>>()
vi.mock('../api', () => ({ getLogs: (q: LogsQuery) => getLogs(q) }))

import RunnerLogs from '../RunnerLogs.vue'

const line = (seq: number, level: RunnerLogLine['level'] = 'info'): RunnerLogLine => ({
  seq,
  time: '2026-10-20T12:00:00Z',
  level,
  scope: 'engine',
  message: `m${seq}`,
})
const page = (lines: RunnerLogLine[], last_seq = lines.at(-1)?.seq ?? 0): Page => ({
  lines,
  last_seq,
  capacity: 2000,
})

let mounted: { unmount: () => void } | null = null
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  getLogs.mockReset()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
})

async function render() {
  const w = mount(RunnerLogs)
  mounted = w
  await flushPromises()
  return w
}

describe('RunnerLogs', () => {
  it('trae todo, lo más nuevo arriba, y se relee cada 3 s pidiendo sólo lo nuevo', async () => {
    getLogs
      .mockResolvedValueOnce(page([line(1), line(2, 'warn')]))
      .mockResolvedValue(page([line(3, 'error')]))
    const w = await render()
    expect(getLogs).toHaveBeenLastCalledWith({ level: undefined, after: 0, limit: 500 })
    expect(w.findAll('.ll__msg').map((m) => m.text())).toEqual(['m2', 'm1'])
    expect(w.get('[data-test="filter-all"]').attributes('aria-pressed')).toBe('true')
    vi.advanceTimersByTime(3000)
    await flushPromises()
    expect(getLogs).toHaveBeenLastCalledWith({ level: undefined, after: 2, limit: 500 })
    expect(w.findAll('.ll__msg').map((m) => m.text())).toEqual(['m3', 'm2', 'm1'])
    expect(w.text()).toContain('3 líneas · se actualiza cada 3 s')
  })

  it('Errores vuelve a pedir desde cero con level=error', async () => {
    getLogs
      .mockResolvedValueOnce(page([line(1), line(2)]))
      .mockResolvedValue(page([line(2, 'error')], 7))
    const w = await render()
    await w.get('[data-test="filter-error"]').trigger('click')
    await flushPromises()
    expect(getLogs).toHaveBeenLastCalledWith({ level: 'error', after: 0, limit: 500 })
    expect(w.get('[data-test="filter-error"]').attributes('aria-pressed')).toBe('true')
    expect(w.findAll('.ll__msg').map((m) => m.text())).toEqual(['m2'])
  })

  it('sin líneas lo dice', async () => {
    getLogs.mockResolvedValue(page([]))
    const w = await render()
    expect(w.get('[data-test="empty"]').text()).toBe('Sin líneas todavía.')
    expect(w.find('[data-test="copy"]').exists()).toBe(false)
  })

  it('un runner sin /api/logs: lo dice, sin segmentado roto ni Copiar', async () => {
    getLogs.mockResolvedValue(null)
    const w = await render()
    expect(w.get('[data-test="unsupported"]').text()).toContain('/api/logs')
    expect(w.find('[data-test="copy"]').exists()).toBe(false)
  })

  it('un error de red sale con Reintentar', async () => {
    getLogs.mockRejectedValueOnce(new Error('Network Error')).mockResolvedValue(page([line(1)]))
    const w = await render()
    expect(w.get('[role="alert"]').text()).toContain('No se pudo leer el log: Network Error')
    await w.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(w.find('[role="alert"]').exists()).toBe(false)
    expect(w.findAll('.ll__msg').map((m) => m.text())).toEqual(['m1'])
  })

  it('Copiar copia lo que se ve, como lo imprime el proceso', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    getLogs.mockResolvedValue(page([line(1)]))
    const w = await render()
    await w.get('[data-test="copy"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('2026-10-20T12:00:00Z INFO [engine] m1')
    expect(w.get('[data-test="copy"]').text()).toBe('✓ Copiado')
  })
})
