import { describe, expect, it } from 'bun:test'
import { RefreshingCache } from './RefreshingCache.js'

/** Un load que se resuelve a mano: cuenta cuántas lecturas arrancaron. */
function manualLoad() {
  const pending: Array<(value: number) => void> = []
  const failures: Array<(error: Error) => void> = []
  let next = 0
  return {
    load: () =>
      new Promise<number>((resolve, reject) => {
        pending.push(resolve)
        failures.push(reject)
      }),
    started: () => pending.length,
    resolve: (value = ++next) => pending.shift()?.(value) ?? failures.shift(),
    fail: (error = new Error('GitHub caído')) => {
      pending.shift()
      failures.shift()?.(error)
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('RefreshingCache', () => {
  it('el primero espera la lectura y los que llegan juntos la comparten', async () => {
    const source = manualLoad()
    const cache = new RefreshingCache(source.load, { ttlMs: 60_000 })
    const a = cache.get()
    const b = cache.get()
    expect(source.started()).toBe(1)
    source.resolve(7)
    expect(await a).toBe(7)
    expect(await b).toBe(7)
  })

  it('markStale no frena: sirve el valor viejo y relee una sola vez en segundo plano', async () => {
    const source = manualLoad()
    const seen: Array<[number | undefined, number]> = []
    const cache = new RefreshingCache(source.load, {
      ttlMs: 60_000,
      onRefreshed: (before, after) => seen.push([before, after]),
    })
    const first = cache.get()
    source.resolve(1)
    await first

    cache.markStale()
    cache.markStale()
    expect(await cache.get()).toBe(1)
    expect(await cache.get()).toBe(1)
    expect(source.started()).toBe(1)
    source.resolve(2)
    await tick()
    expect(await cache.get()).toBe(2)
    expect(seen).toEqual([
      [undefined, 1],
      [1, 2],
    ])
  })

  it('un webhook durante la relectura deja pedida otra (una sola) para después', async () => {
    const source = manualLoad()
    const cache = new RefreshingCache(source.load, { ttlMs: 60_000 })
    const first = cache.get()
    source.resolve(1)
    await first
    cache.markStale()
    await cache.get()
    cache.markStale()
    cache.markStale()
    source.resolve(2)
    await tick()
    expect(await cache.get()).toBe(2)
    expect(source.started()).toBe(1)
    source.resolve(3)
    await tick()
    expect(await cache.get()).toBe(3)
  })

  it('pasado el ttl sirve el viejo y relee en segundo plano', async () => {
    let now = 0
    const source = manualLoad()
    const cache = new RefreshingCache(source.load, { ttlMs: 1_000, now: () => now })
    const first = cache.get()
    source.resolve(1)
    await first
    now = 500
    expect(await cache.get()).toBe(1)
    expect(source.started()).toBe(0)
    now = 1_500
    expect(await cache.get()).toBe(1)
    expect(source.started()).toBe(1)
  })

  it('invalidate: el próximo espera una lectura nueva; la que estaba en vuelo no cuenta', async () => {
    const source = manualLoad()
    const cache = new RefreshingCache(source.load, { ttlMs: 60_000 })
    const first = cache.get()
    source.resolve(1)
    await first
    cache.markStale()
    await cache.get() // arranca una relectura (la «vieja»)
    cache.invalidate()
    const fresh = cache.get() // no se suma a la vieja
    expect(source.started()).toBe(2)
    source.resolve(10) // la vieja termina: no se guarda
    source.resolve(11)
    expect(await fresh).toBe(11)
    expect(await cache.get()).toBe(11)
  })

  it('una relectura que falla deja el valor viejo y no reintenta hasta retryMs', async () => {
    let now = 0
    const errors: unknown[] = []
    const source = manualLoad()
    const cache = new RefreshingCache(source.load, {
      ttlMs: 60_000,
      retryMs: 5_000,
      now: () => now,
      onError: (error) => errors.push(error),
    })
    const first = cache.get()
    source.resolve(1)
    await first
    cache.markStale()
    expect(await cache.get()).toBe(1)
    source.fail()
    await tick()
    expect(errors).toHaveLength(1)
    now = 1_000
    expect(await cache.get()).toBe(1)
    expect(source.started()).toBe(0)
    now = 6_000
    expect(await cache.get()).toBe(1)
    expect(source.started()).toBe(1)
  })

  it('sin valor, el error llega a quien pidió', async () => {
    const source = manualLoad()
    const cache = new RefreshingCache(source.load, { ttlMs: 60_000, onError: () => {} })
    const first = cache.get()
    source.fail(new Error('sin acceso al board'))
    await expect(first).rejects.toThrow('sin acceso al board')
  })
})
