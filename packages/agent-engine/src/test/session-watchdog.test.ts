import { describe, expect, it, mock } from 'bun:test'
import type { SessionHandle } from '@ia-flow/ai-providers'
import { watchSession } from '../session-watchdog.js'

function makeHandle(isAlive: () => Promise<boolean> | boolean): SessionHandle {
  return {
    kind: 'iterm',
    id: 'session-1',
    isAlive: async () => isAlive(),
    close: async () => {},
  } as unknown as SessionHandle
}

describe('watchSession — confirmChecks', () => {
  it('does NOT fire onDead on a single false reading (transient blip)', async () => {
    let alive = false
    const handle = makeHandle(() => alive)
    const onDead = mock(() => {})

    const unwatch = watchSession(handle, onDead, { graceMs: 1, intervalMs: 50, confirmChecks: 2 })
    await new Promise((r) => setTimeout(r, 15)) // one tick (~1ms): reads false, doesn't fire yet

    expect(onDead).not.toHaveBeenCalled()

    alive = true
    unwatch()
    expect(onDead).not.toHaveBeenCalled()
  })

  it('fires onDead after N consecutive false readings', async () => {
    const handle = makeHandle(() => false)
    const onDead = mock(() => {})

    watchSession(handle, onDead, { graceMs: 1, intervalMs: 5, confirmChecks: 2 })
    await new Promise((r) => setTimeout(r, 30))

    expect(onDead).toHaveBeenCalledTimes(1)
  })

  it('fires on the first false reading when confirmChecks=1 (legacy behavior)', async () => {
    const handle = makeHandle(() => false)
    const onDead = mock(() => {})

    watchSession(handle, onDead, { graceMs: 1, intervalMs: 5, confirmChecks: 1 })
    await new Promise((r) => setTimeout(r, 12))

    expect(onDead).toHaveBeenCalledTimes(1)
  })

  it('a recovering reading between two false ones resets the streak', async () => {
    const readings = [false, true, false, false]
    const handle = makeHandle(() => readings.shift() ?? false)
    const onDead = mock(() => {})

    watchSession(handle, onDead, { graceMs: 1, intervalMs: 5, confirmChecks: 2 })
    await new Promise((r) => setTimeout(r, 40))

    // Sequence: false(1) -> true(reset) -> false(1) -> false(2, fires)
    expect(onDead).toHaveBeenCalledTimes(1)
  })
})
