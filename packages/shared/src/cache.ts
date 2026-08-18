// Cross-cutting method-level cache. Apply `@memoize()` to any class method —
// sync or async — to memoize its return value per (instance, args), instead
// of hand-rolling a `Map<key, {value, at}>` next to the class. A pending
// promise is cached too, so concurrent callers dedupe onto the same
// in-flight call instead of firing N requests.
//
// Storage is a WeakMap keyed by the instance, so entries die with it — no
// leak, no manual teardown. To drop cached values on purpose (e.g. the
// source's config changed), either discard the instance (its cache goes
// with it) or call `invalidateMemoized`.

interface Entry {
  value: unknown
  expiresAt: number
}

const store = new WeakMap<object, Map<string, Map<string, Entry>>>()

function entriesFor(instance: object, methodName: string): Map<string, Entry> {
  let byMethod = store.get(instance)
  if (!byMethod) {
    byMethod = new Map()
    store.set(instance, byMethod)
  }
  let entries = byMethod.get(methodName)
  if (!entries) {
    entries = new Map()
    byMethod.set(methodName, entries)
  }
  return entries
}

export interface MemoizeOptions<Args extends unknown[] = unknown[]> {
  /** How long a value stays fresh. Default: forever, until invalidated. */
  ttlMs?: number
  /** Cache key derived from the call args. Default: `JSON.stringify(args)`. */
  key?: (...args: Args) => string
  /** When true for a given call, skip the cache read — still repopulates it. */
  bypass?: (...args: Args) => boolean
}

/**
 * Method decorator: memoizes per (instance, key(...args)). Uses the legacy
 * (`experimentalDecorators`) decorator shape — Bun's runtime transpiler
 * doesn't apply the TC39 method-decorator replacement, only the legacy one.
 * Every package that uses `@memoize` needs `experimentalDecorators: true` in
 * its tsconfig.
 */
export function memoize<Args extends unknown[], Return>(options: MemoizeOptions<Args> = {}) {
  const ttlMs = options.ttlMs ?? Number.POSITIVE_INFINITY
  const keyFn = options.key ?? ((...args: Args) => JSON.stringify(args))
  const bypassFn = options.bypass

  return (
    _target: object,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<(...args: Args) => Return>,
  ): void => {
    const original = descriptor.value
    if (!original) throw new Error(`@memoize can only decorate a method (got '${propertyKey}')`)
    descriptor.value = function (this: object, ...args: Args): Return {
      const entries = entriesFor(this, propertyKey)
      const cacheKey = keyFn(...args)
      const now = Date.now()
      if (!bypassFn?.(...args)) {
        const hit = entries.get(cacheKey)
        if (hit && hit.expiresAt > now) return hit.value as Return
      }
      const value = original.call(this, ...args)
      const entry: Entry = { value, expiresAt: now + ttlMs }
      entries.set(cacheKey, entry)
      // Cache the settled value once the promise resolves, so a later
      // peekMemoized (which never awaits) can read it. A rejection drops the
      // entry — failures aren't memoized.
      if (value instanceof Promise) {
        value.then(
          (resolved) => {
            entry.value = resolved
          },
          () => {
            entries.delete(cacheKey)
          },
        )
      }
      return value
    }
  }
}

/** Drops all cached entries for a method, or the whole instance if `methodName` is omitted. */
export function invalidateMemoized(instance: object, methodName?: string): void {
  const byMethod = store.get(instance)
  if (!byMethod) return
  if (methodName) byMethod.delete(methodName)
  else byMethod.clear()
}

/**
 * Synchronous read of an already-settled cache entry, without invoking the
 * method. `key` must match what the method's `MemoizeOptions.key` produces
 * for the call you're peeking at (default: `JSON.stringify(args)`). Returns
 * undefined on a miss, an expired entry, or a still-pending promise —
 * escape hatch for callers that must stay sync but need "is this warm?".
 */
export function peekMemoized<T>(instance: object, methodName: string, key: string): T | undefined {
  const entry = store.get(instance)?.get(methodName)?.get(key)
  if (!entry || entry.expiresAt <= Date.now() || entry.value instanceof Promise) return undefined
  return entry.value as T
}
