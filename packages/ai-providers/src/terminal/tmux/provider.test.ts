import { describe, expect, it } from 'bun:test'
import { shouldSurfaceInTerminal } from './provider.js'

describe('shouldSurfaceInTerminal', () => {
  it('runs headless when there are no tmux settings at all', () => {
    expect(shouldSurfaceInTerminal(undefined)).toBe(false)
  })

  it('runs headless when the flag was never set — abrir iTerm es opt-in', () => {
    expect(shouldSurfaceInTerminal({})).toBe(false)
    expect(shouldSurfaceInTerminal({ model: 'sonnet' })).toBe(false)
  })

  it('surfaces only with an explicit true', () => {
    expect(shouldSurfaceInTerminal({ surfaceInTerminal: true })).toBe(true)
    expect(shouldSurfaceInTerminal({ surfaceInTerminal: false })).toBe(false)
  })
})
