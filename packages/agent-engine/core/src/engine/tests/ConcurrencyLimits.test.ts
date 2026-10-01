import { describe, expect, it } from 'vitest'
import { ConcurrencyLimits } from '../ConcurrencyLimits.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ConcurrencyLimits', () => {
  it('waits for a slot in every limited name, and ignores the unlimited ones', async () => {
    const limits = new ConcurrencyLimits()
    const first = await limits.acquire([
      { key: 'agent:a', max: 1 },
      { key: 'provider:p', max: 2 },
      { key: 'agent:free' },
    ])
    let second = false
    void limits.acquire([{ key: 'agent:a', max: 1 }]).then(() => {
      second = true
    })
    await tick()
    expect(second).toBe(false)
    expect(limits.active('provider:p')).toBe(1)
    expect(limits.active('agent:free')).toBe(0)

    first()
    first()
    await tick()
    expect(second).toBe(true)
    expect(limits.active('provider:p')).toBe(0)
  })

  it('takes a new cap for a name when the config changes', async () => {
    const limits = new ConcurrencyLimits()
    await limits.acquire([{ key: 'agent:a', max: 1 }])
    let second = false
    void limits.acquire([{ key: 'agent:a', max: 2 }]).then(() => {
      second = true
    })
    await tick()
    expect(second).toBe(true)
  })
})
