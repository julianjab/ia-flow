import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useTaskFocusStore } from '../taskFocus'

describe('useTaskFocusStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('el pedido queda hasta que la bandeja lo consume, una sola vez', () => {
    const s = useTaskFocusStore()
    s.focus('a/b#1')
    expect(s.consume()).toBe('a/b#1')
    expect(s.consume()).toBeNull()
  })
})
