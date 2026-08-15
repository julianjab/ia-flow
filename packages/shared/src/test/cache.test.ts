import { describe, expect, it, mock } from 'bun:test'
import { invalidateMemoized, memoize, peekMemoized } from '../cache.js'

describe('memoize', () => {
  it('caches a sync method per instance', () => {
    const spy = mock((n: number) => n * 2)
    class Calc {
      @memoize()
      double(n: number) {
        return spy(n)
      }
    }
    const a = new Calc()
    const b = new Calc()
    expect(a.double(3)).toBe(6)
    expect(a.double(3)).toBe(6)
    expect(b.double(3)).toBe(6)
    expect(spy).toHaveBeenCalledTimes(2) // once per instance, second call on `a` is a hit
  })

  it('keys by args — different args miss the cache', () => {
    const spy = mock((n: number) => n * 2)
    class Calc {
      @memoize()
      double(n: number) {
        return spy(n)
      }
    }
    const c = new Calc()
    c.double(1)
    c.double(2)
    c.double(1)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('expires entries after ttlMs', async () => {
    const spy = mock(() => Date.now())
    class Clock {
      @memoize({ ttlMs: 10 })
      now() {
        return spy()
      }
    }
    const clock = new Clock()
    clock.now()
    clock.now()
    expect(spy).toHaveBeenCalledTimes(1)
    await new Promise((r) => setTimeout(r, 20))
    clock.now()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent async calls onto the same in-flight promise', async () => {
    let calls = 0
    class Fetcher {
      @memoize()
      async load() {
        calls++
        await new Promise((r) => setTimeout(r, 5))
        return 'data'
      }
    }
    const f = new Fetcher()
    const [x, y] = await Promise.all([f.load(), f.load()])
    expect(x).toBe('data')
    expect(y).toBe('data')
    expect(calls).toBe(1)
  })

  it('does not cache a rejected promise', async () => {
    let attempt = 0
    class Flaky {
      @memoize()
      async run() {
        attempt++
        if (attempt === 1) throw new Error('boom')
        return 'ok'
      }
    }
    const flaky = new Flaky()
    await expect(flaky.run()).rejects.toThrow('boom')
    await expect(flaky.run()).resolves.toBe('ok')
    expect(attempt).toBe(2)
  })

  it('a settled cache hit still returns a Promise, not the unwrapped value', async () => {
    class Async {
      @memoize()
      async load() {
        return 'value'
      }
    }
    const a = new Async()
    const first = a.load()
    await first
    const second = a.load() // cache hit, entry already settled
    expect(second).toBeInstanceOf(Promise)
    expect(typeof second.then).toBe('function')
    await expect(second).resolves.toBe('value')
  })

  it('a stale rejection does not clobber a fresher entry written by a bypassed call', async () => {
    let calls = 0
    class Flaky {
      @memoize({ key: () => 'const', bypass: (refresh?: boolean) => refresh === true })
      async load(refresh?: boolean) {
        calls++
        if (calls === 1) {
          // First call is slow to fail.
          await new Promise((r) => setTimeout(r, 20))
          throw new Error('stale failure')
        }
        return 'fresh'
      }
    }
    const flaky = new Flaky()
    const stale = flaky.load() // in-flight, will reject in 20ms
    const fresh = await flaky.load(true) // bypass writes a fresh entry immediately
    expect(fresh).toBe('fresh')
    await expect(stale).rejects.toThrow('stale failure')
    // The stale rejection must not have deleted the fresh entry.
    expect(await flaky.load()).toBe('fresh')
    expect(calls).toBe(2)
  })

  it('supports a custom key and bypass predicate', () => {
    const spy = mock((opts?: { refresh?: boolean }) => `v${Date.now()}-${opts?.refresh}`)
    class Source {
      @memoize({
        key: () => 'const',
        bypass: (opts?: { refresh?: boolean }) => opts?.refresh === true,
      })
      load(opts?: { refresh?: boolean }) {
        return spy(opts)
      }
    }
    const s = new Source()
    s.load()
    s.load({ refresh: false })
    expect(spy).toHaveBeenCalledTimes(1) // same key 'const' regardless of refresh
    s.load({ refresh: true })
    expect(spy).toHaveBeenCalledTimes(2) // bypass forces a fresh call
    s.load()
    expect(spy).toHaveBeenCalledTimes(2) // re-reads the entry the refresh call just wrote
  })

  it('invalidateMemoized drops a method or the whole instance', () => {
    const spy = mock((n: number) => n)
    class Store {
      @memoize()
      get(n: number) {
        return spy(n)
      }
    }
    const store = new Store()
    store.get(1)
    invalidateMemoized(store, 'get')
    store.get(1)
    expect(spy).toHaveBeenCalledTimes(2)

    store.get(1) // cache hit, still 2
    invalidateMemoized(store)
    store.get(1)
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('peekMemoized reads a settled entry without invoking the method, and misses when cold', async () => {
    class Async {
      @memoize()
      async load() {
        return 'value'
      }
    }
    const a = new Async()
    expect(peekMemoized<string>(a, 'load', '[]')).toBeUndefined()
    await a.load()
    expect(peekMemoized<string>(a, 'load', '[]')).toBe('value')
  })
})
