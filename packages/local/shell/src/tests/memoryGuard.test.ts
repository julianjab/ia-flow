import { describe, expect, it } from 'vitest'
import { sumGroupRssBytes, watchGroupMemory } from '../memoryGuard.js'

describe('sumGroupRssBytes', () => {
  it('suma sólo el RSS (KB → bytes) de las líneas del grupo', () => {
    const ps = ['  100  2048', '  200  1024', '  100   512', '   50     8', ''].join('\n')

    expect(sumGroupRssBytes(ps, 100)).toBe((2048 + 512) * 1024)
    expect(sumGroupRssBytes(ps, 999)).toBe(0)
  })

  it('ignora líneas ilegibles en vez de contar NaN', () => {
    expect(sumGroupRssBytes('100 abc\nbasura\n100 4', 100)).toBe(4 * 1024)
  })
})

describe('watchGroupMemory', () => {
  const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

  it('avisa una sola vez cuando el grupo pasa del tope', async () => {
    const exceeded: number[] = []
    const stop = watchGroupMemory({
      pgid: 1,
      maxBytes: 1_000,
      sample: async () => 5_000,
      onExceeded: (used) => exceeded.push(used),
      intervalMs: 5,
    })

    await tick()
    stop()

    expect(exceeded).toEqual([5_000])
  })

  it('no avisa si el grupo se mantiene bajo el tope, ni después de detenerlo', async () => {
    let used = 100
    const exceeded: number[] = []
    const stop = watchGroupMemory({
      pgid: 1,
      maxBytes: 1_000,
      sample: async () => used,
      onExceeded: (bytes) => exceeded.push(bytes),
      intervalMs: 5,
    })

    await tick()
    stop()
    used = 9_999
    await tick()

    expect(exceeded).toEqual([])
  })
})
