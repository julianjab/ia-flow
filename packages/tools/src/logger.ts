// Package-local logger indirection. This package must not import
// apps/server's `logger.ts` directly (that would create a package →
// host-app dependency and break the "typecheck in isolation" contract).
//
// Instead the host wires its real logger factory in once at boot
// (`setLoggerFactory(createLogger)` in apps/server/src/composition/container.ts,
// or index.ts before anything in this package runs). Every module below keeps
// calling `createLogger('scope')` exactly like it did before the move — only
// the import path changed — so log output, file destination, and the
// WS-broadcast mirroring already wired into apps/server's logger keep working
// unchanged. `.child()` is included (unlike the identical pattern in
// issue-sources/agent-engine) because `engine.ts`'s executeLoop binds a
// per-run child logger to carry correlation ids into compaction logs.
export interface Logger {
  info(obj: object, msg?: string): void
  debug(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
  child(bindings: Record<string, unknown>): Logger
}

export type LoggerFactory = (scope: string) => Logger

function makeNoopLogger(): Logger {
  const noop: Logger = {
    info() {},
    debug() {},
    warn() {},
    error() {},
    child: () => noop,
  }
  return noop
}

let factory: LoggerFactory | null = null
// Real loggers created before the host calls setLoggerFactory (every
// `const log = createLogger('scope')` at the top of a moved module runs at
// *import* time, which happens before the host's composition root — the
// first thing that imports this package — has a chance to call
// setLoggerFactory). Buffered here and rebound once the factory arrives, so
// none of those module-level loggers get stuck on the no-op sink.
const pending: Array<{ scope: string; target: Logger }> = []

/** Called once by the host app at boot to route this package's logs through
 *  its real logger (Pino + WS broadcast, file output, etc.). Rebinds every
 *  logger created before this call (see `pending` above). */
export function setLoggerFactory(f: LoggerFactory): void {
  factory = f
  for (const { scope, target } of pending) rebind(target, f(scope))
  pending.length = 0
}

function rebind(target: Logger, real: Logger): void {
  target.info = real.info.bind(real)
  target.debug = real.debug.bind(real)
  target.warn = real.warn.bind(real)
  target.error = real.error.bind(real)
  target.child = real.child.bind(real)
}

export function createLogger(scope: string): Logger {
  if (factory) return factory(scope)
  // No factory yet — hand back a mutable stand-in that starts as a no-op and
  // gets rebound in place once setLoggerFactory runs.
  const stub = makeNoopLogger()
  pending.push({ scope, target: stub })
  return stub
}
