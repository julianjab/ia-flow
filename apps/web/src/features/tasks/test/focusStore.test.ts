import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchTaskFocus = vi.fn()
vi.mock('@/features/tasks/api', () => ({
  fetchTaskFocus: (...a: unknown[]) => fetchTaskFocus(...a),
}))

import { useFocusStore } from '../focusStore'

const FOCUS = { headline: 'h', picks: [], clusters: [], computedAt: '2026-09-07T12:00:00.000Z' }

beforeEach(() => {
  setActivePinia(createPinia())
  fetchTaskFocus.mockReset()
})

describe('focusStore', () => {
  it('no repite lo ya cargado — el endpoint llama a un modelo', async () => {
    fetchTaskFocus.mockResolvedValue(FOCUS)
    const s = useFocusStore()
    await s.fetch('p1')
    await s.fetch('p1')
    expect(fetchTaskFocus).toHaveBeenCalledTimes(1)
    expect(s.focusFor('p1')).toEqual(FOCUS)
  })

  it('dedupea dos consumidores que montan a la vez', async () => {
    fetchTaskFocus.mockResolvedValue(FOCUS)
    const s = useFocusStore()
    await Promise.all([s.fetch('p1'), s.fetch('p1')])
    expect(fetchTaskFocus).toHaveBeenCalledTimes(1)
  })

  it('`force` pide de nuevo y manda refresh: es el reintentar del degradado', async () => {
    fetchTaskFocus.mockResolvedValue(FOCUS)
    const s = useFocusStore()
    await s.fetch('p1')
    await s.fetch('p1', { force: true })
    expect(fetchTaskFocus).toHaveBeenCalledTimes(2)
    expect(fetchTaskFocus).toHaveBeenLastCalledWith('p1', { refresh: true })
  })

  it('un foco nulo se cachea: "no hay nada que decir" es una respuesta', async () => {
    fetchTaskFocus.mockResolvedValue(null)
    const s = useFocusStore()
    await s.fetch('p1')
    await s.fetch('p1')
    expect(fetchTaskFocus).toHaveBeenCalledTimes(1)
    expect(s.isLoaded('p1')).toBe(true)
    expect(s.hasFailed('p1')).toBe(false)
  })

  it('un fallo deja el proyecto SIN entrada, para poder distinguirlo de null', async () => {
    fetchTaskFocus.mockRejectedValue(new Error('502'))
    const s = useFocusStore()
    await s.fetch('p1')
    expect(s.hasFailed('p1')).toBe(true)
    // Sin esto la card no podría separar "no hay nada" de "no se pudo".
    expect(s.isLoaded('p1')).toBe(false)
    expect(s.isLoading('p1')).toBe(false)
  })

  it('un fallo no bloquea el siguiente intento', async () => {
    fetchTaskFocus.mockRejectedValueOnce(new Error('502')).mockResolvedValue(FOCUS)
    const s = useFocusStore()
    await s.fetch('p1')
    await s.fetch('p1')
    expect(s.hasFailed('p1')).toBe(false)
    expect(s.focusFor('p1')).toEqual(FOCUS)
  })
})
