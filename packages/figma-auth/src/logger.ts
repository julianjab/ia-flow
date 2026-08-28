// Misma indirección de logger que `@ia-flow/github-auth` y
// `@ia-flow/agent-engine`: el paquete no puede importar el logger de
// apps/server (sería una dependencia paquete → app y rompe el typecheck en
// aislamiento). El host cablea el suyo una vez en el composition root.
export interface Logger {
  info(obj: object, msg?: string): void
  debug(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export type LoggerFactory = (scope: string) => Logger

const noop: Logger = { info() {}, debug() {}, warn() {}, error() {} }

let factory: LoggerFactory | null = null
// Los `const log = createLogger(...)` de arriba de cada módulo corren al
// importar, antes de que el host pueda cablear nada. Se bufferean y se
// rebindean in-place cuando llega el factory real.
const pending: Array<{ scope: string; target: Logger }> = []

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
}

export function createLogger(scope: string): Logger {
  if (factory) return factory(scope)
  const stub: Logger = { ...noop }
  pending.push({ scope, target: stub })
  return stub
}
