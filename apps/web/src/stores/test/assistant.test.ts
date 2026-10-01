import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAssistantStore } from '../assistant'

describe('useAssistantStore (estado de apertura)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('abrir sin contexto no pide nada', () => {
    const s = useAssistantStore()
    s.open()
    expect(s.isOpen).toBe(true)
    expect(s.request).toBeNull()
    s.close()
    expect(s.isOpen).toBe(false)
  })

  it('abrir con un contexto lo deja pedido hasta que el panel lo consume, una sola vez', () => {
    const s = useAssistantStore()
    s.open({ kind: 'task', ref: 'a/b#1' })
    expect(s.request).toEqual({ kind: 'task', ref: 'a/b#1' })
    expect(s.consumeRequest()).toEqual({ kind: 'task', ref: 'a/b#1' })
    expect(s.consumeRequest()).toBeNull()
  })
})
