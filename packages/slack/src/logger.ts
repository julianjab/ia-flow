// Indirección de logger, local al paquete.
//
// Mismo patrón que `@ia-flow/tools/src/logger.ts` y por el mismo motivo: un
// paquete no puede importar `apps/server/src/logger.ts` sin volverse
// dependiente de la app que lo hospeda. El host cablea su factory una vez
// (`installSlack({ logger: createLogger })`) y todo lo de acá sigue llamando a
// `createLogger('scope')` como antes del movimiento.
//
// La interfaz es más angosta que la del server a propósito: acá nadie usa
// `.child()`, y un port declara lo que el consumidor necesita, no todo lo que
// el proveedor sabe hacer.
export interface Logger {
  info(obj: object, msg?: string): void
  debug(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export type LoggerFactory = (scope: string) => Logger

function makeNoopLogger(): Logger {
  return { info() {}, debug() {}, warn() {}, error() {} }
}

let factory: LoggerFactory | null = null

// Los `const log = createLogger('scope')` de cada módulo corren al IMPORTAR,
// que es antes de que el host llegue a cablear su factory. Se anotan acá y se
// rebindean en el lugar cuando llega, para que no queden pegados al no-op.
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
  const stub = makeNoopLogger()
  pending.push({ scope, target: stub })
  return stub
}
